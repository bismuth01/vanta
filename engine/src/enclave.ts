// ─────────────────────────────────────────────────────────────────────────────
//  Vanta enclave: everything in this file is what would run inside an Intel TDX
//  confidential VM (e.g. Phala dstack) in production. For the hackathon it runs
//  as a normal process. The trust boundary and data flow are the same:
//
//    • keys are generated inside and never leave (signing + x25519 encryption)
//    • the quote binds (signer, encryptionKey) to the code measurement
//    • strategies arrive encrypted and are only decrypted in memory here
//    • strategy bytecode is executed with eth_call + state override against
//      live chain state; it is never deployed
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  toHex,
  type Abi,
  type Hex,
  type PublicClient,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { generateEncryptionKey, open, rawPublicKey } from './crypto.ts'
import { commitment, decodePayload } from './sealed.ts'
import { MULTICALL3, MULTICALL3_CODE } from './multicall3.ts'

export type Fill = { strategyId: Hex; isBuy: boolean; baseAmount: bigint }
export type Batch = { batchId: bigint; validUntilBlock: bigint; price: bigint; fills: Fill[] }

export type SealedStrategy = {
  id: Hex
  firm: Hex
  firmName: string
  label: string
  contract: string
  code: Hex
  state: Hex
  phantom: Hex
  codeSize: number
  sealedSize: number
  fired: number
  lastMs: number
}

export type EvalResult = {
  id: Hex
  order: { isBuy: boolean; baseAmount: bigint } | null
  ms: number
  batched: boolean
  error?: string
}

/// Extra plain reads (oracle, AMM…) that ride along in the same eth_call as the strategies.
export type Read = { target: Hex; callData: Hex }

const AGGREGATE3_ABI = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const

const BATCH_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'batchId', type: 'uint256' },
    { name: 'validUntilBlock', type: 'uint256' },
    { name: 'price', type: 'uint256' },
    {
      name: 'fills',
      type: 'tuple[]',
      components: [
        { name: 'strategyId', type: 'bytes32' },
        { name: 'isBuy', type: 'bool' },
        { name: 'baseAmount', type: 'uint256' },
      ],
    },
  ],
} as const

export class Enclave {
  readonly measurement: Hex
  readonly encryptionKey: Hex
  readonly signer
  readonly strategies = new Map<Hex, SealedStrategy>()
  private readonly encKeys = generateEncryptionKey()
  private readonly encPubRaw: Buffer
  private readonly strategyAbi: Abi

  constructor(strategyAbi: Abi) {
    this.strategyAbi = strategyAbi
    this.signer = privateKeyToAccount(generatePrivateKey())
    this.encPubRaw = rawPublicKey(this.encKeys.publicKey)
    this.encryptionKey = toHex(this.encPubRaw)
    // Stand-in for MRTD/RTMR: hash of the code that runs inside the enclave.
    const files = ['enclave.ts', 'crypto.ts', 'sealed.ts'].map((f) =>
      readFileSync(fileURLToPath(new URL(f, import.meta.url))),
    )
    this.measurement = keccak256(Buffer.concat(files))
  }

  /// Mock TDX quote: (measurement, reportData = keccak(signer, encryptionKey)).
  quote(): Hex {
    const reportData = keccak256(
      encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [this.signer.address, this.encryptionKey]),
    )
    return encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [this.measurement, reportData])
  }

  /// Accept a sealed strategy. `onchainOwner` comes from DarkPool.strategies(id).
  ingest(id: Hex, onchainOwner: Hex, sealedB64: string): SealedStrategy {
    const sealed = Buffer.from(sealedB64, 'base64')
    const payload = decodePayload(open(this.encKeys.privateKey, this.encPubRaw, sealed))
    if (commitment(payload.code, payload.initState) !== id) throw new Error('commitment mismatch')
    const existing = this.strategies.get(id)
    if (existing) {
      // Re-seal (new enclave key or scenario replay): keep the slot, reset private state.
      existing.state = payload.initState
      existing.sealedSize = sealed.length
      return existing
    }
    const idx = this.strategies.size + 1
    const s: SealedStrategy = {
      id,
      firm: onchainOwner,
      firmName: payload.firmName,
      label: payload.label,
      contract: payload.contract,
      code: payload.code,
      state: payload.initState,
      phantom: pad(toHex(0x5ea1ed0000 + idx), { size: 20 }),
      codeSize: (payload.code.length - 2) / 2,
      sealedSize: sealed.length,
      fired: 0,
      lastMs: 0,
    }
    this.strategies.set(id, s)
    return s
  }

  /// Run every sealed strategy (plus `reads`) against the state at `blockNumber`.
  ///   parallel:  one eth_call per strategy → per-strategy timings
  ///   multicall: everything in ONE eth_call via Multicall3 → fits public-RPC rate limits
  async evaluate(
    sim: PublicClient,
    blockNumber: bigint,
    ctxBase: Record<string, unknown>,
    mode: 'parallel' | 'multicall',
    reads: Read[] = [],
  ): Promise<{ results: EvalResult[]; reads: (Hex | null)[] }> {
    const all = [...this.strategies.values()]
    const checkData = (s: SealedStrategy) =>
      encodeFunctionData({ abi: this.strategyAbi, functionName: 'check', args: [{ ...ctxBase, firm: s.firm }, s.state] })

    if (mode === 'multicall') {
      const t0 = performance.now()
      const calls = [
        ...reads.map((r) => ({ target: r.target, allowFailure: true, callData: r.callData })),
        ...all.map((s) => ({ target: s.phantom, allowFailure: true, callData: checkData(s) })),
      ]
      const { data } = await sim.call({
        to: MULTICALL3,
        data: encodeFunctionData({ abi: AGGREGATE3_ABI, functionName: 'aggregate3', args: [calls] }),
        blockNumber,
        stateOverride: [{ address: MULTICALL3, code: MULTICALL3_CODE }, ...all.map((s) => ({ address: s.phantom, code: s.code }))],
      })
      const out = decodeFunctionResult({ abi: AGGREGATE3_ABI, functionName: 'aggregate3', data: data! })
      const ms = performance.now() - t0
      const results = all.map((s, i) => {
        const r = out[reads.length + i]
        return r.success ? this.apply(s, r.returnData, ms, true) : this.failed(s, ms, true, 'strategy reverted')
      })
      return { results, reads: out.slice(0, reads.length).map((r) => (r.success ? r.returnData : null)) }
    }

    const readsP = Promise.all(
      reads.map((r) =>
        sim
          .call({ to: r.target, data: r.callData, blockNumber })
          .then((x) => x.data ?? null)
          .catch(() => null),
      ),
    )
    const results = await Promise.all(
      all.map(async (s) => {
        const t0 = performance.now()
        try {
          const { data } = await sim.call({
            to: s.phantom,
            data: checkData(s),
            blockNumber,
            stateOverride: [{ address: s.phantom, code: s.code }],
          })
          return this.apply(s, data!, performance.now() - t0, false)
        } catch (e) {
          return this.failed(s, performance.now() - t0, false, (e as Error).message.split('\n')[0])
        }
      }),
    )
    return { results, reads: await readsP }
  }

  private apply(s: SealedStrategy, data: Hex, ms: number, batched: boolean): EvalResult {
    const [order, newState] = decodeFunctionResult({
      abi: this.strategyAbi,
      functionName: 'check',
      data,
    }) as unknown as [{ isBuy: boolean; baseAmount: bigint }, Hex]
    s.state = newState // private memory, never leaves the enclave
    s.lastMs = ms
    const fired = order.baseAmount > 0n
    if (fired) s.fired++
    return { id: s.id, order: fired ? order : null, ms, batched }
  }

  private failed(s: SealedStrategy, ms: number, batched: boolean, error: string): EvalResult {
    s.lastMs = ms
    return { id: s.id, order: null, ms, batched, error }
  }

  /// Must equal DarkPool.batchDigest(b) == keccak256(abi.encode(chainid, pool, b)).
  digest(chainId: number, pool: Hex, b: Batch): Hex {
    return keccak256(
      encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, BATCH_TUPLE], [BigInt(chainId), pool, b]),
    )
  }

  sign(chainId: number, pool: Hex, b: Batch): Promise<Hex> {
    return this.signer.signMessage({ message: { raw: this.digest(chainId, pool, b) } })
  }
}
