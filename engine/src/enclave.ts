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
import { commitment, decodePayload, strategyIdOf } from './sealed.ts'

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
  initState: Hex
  phantom: Hex
  codeSize: number
  sealedSize: number
  fired: number
  lastMs: number
  lastGas: number
  guest: boolean
  fillsLeft: number // guest budget (Infinity for house firms)
  expiresAt: number // ms epoch (Infinity for house firms)
  addedAt: number
}

export type EvalResult = {
  id: Hex
  order: { isBuy: boolean; baseAmount: bigint } | null
  ms: number
  gas: number
  batched: boolean
  error?: string
}

/// Extra plain reads (oracle, AMM…) that ride along in the same eth_call as the strategies.
export type Read = { target: Hex; callData: Hex }

/// Gas cap per strategy evaluation: a runaway guest strategy fails alone.
export const STRATEGY_GAS = 1_500_000n
const READ_GAS = 100_000n
const EVALUATOR = '0x00000000000000000000000000000000e7a1e7a1' as const

const EVALUATOR_ABI = [
  {
    type: 'function',
    name: 'run',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'gasLimit', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'results',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'gasUsed', type: 'uint256' },
          { name: 'data', type: 'bytes' },
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
  private readonly evaluatorCode: Hex
  private slots = 0

  constructor(strategyAbi: Abi, evaluatorCode: Hex) {
    this.strategyAbi = strategyAbi
    this.evaluatorCode = evaluatorCode
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

  /// Decrypt and verify a sealed strategy against its on-chain id. Does not store it.
  open(id: Hex, onchainOwner: Hex, sealedB64: string) {
    const sealed = Buffer.from(sealedB64, 'base64')
    const payload = decodePayload(open(this.encKeys.privateKey, this.encPubRaw, sealed))
    if (!/^0x[0-9a-fA-F]*$/.test(payload.code) || !/^0x[0-9a-fA-F]*$/.test(payload.initState)) throw new Error('malformed payload')
    if (strategyIdOf(onchainOwner, commitment(payload.code, payload.initState)) !== id) throw new Error('commitment mismatch')
    return { payload, sealedSize: sealed.length }
  }

  /// Store an opened strategy. Re-sealing an existing id keeps its slot and resets private state.
  add(
    id: Hex,
    onchainOwner: Hex,
    opened: ReturnType<Enclave['open']>,
    policy: { guest: boolean; fillsLeft: number; expiresAt: number },
  ): SealedStrategy {
    const { payload, sealedSize } = opened
    const existing = this.strategies.get(id)
    if (existing) {
      existing.state = payload.initState
      existing.sealedSize = sealedSize
      return existing
    }
    const s: SealedStrategy = {
      id,
      firm: onchainOwner,
      firmName: payload.firmName.slice(0, 40),
      label: payload.label.slice(0, 120),
      contract: payload.contract.slice(0, 40),
      code: payload.code,
      state: payload.initState,
      initState: payload.initState,
      phantom: pad(toHex(0x5ea1ed0000 + ++this.slots), { size: 20 }),
      codeSize: (payload.code.length - 2) / 2,
      sealedSize,
      fired: 0,
      lastMs: 0,
      lastGas: 0,
      addedAt: Date.now(),
      ...policy,
    }
    this.strategies.set(id, s)
    return s
  }

  remove(id: Hex) {
    this.strategies.delete(id)
  }

  /// Dry-run one opened strategy before accepting it (guest uploads).
  async probe(sim: PublicClient, code: Hex, state: Hex, ctx: Record<string, unknown>) {
    const phantom = pad(toHex(0x5ea1edffff), { size: 20 })
    const { data } = await sim.call({
      to: phantom,
      gas: STRATEGY_GAS,
      data: encodeFunctionData({ abi: this.strategyAbi, functionName: 'check', args: [ctx, state] }),
      stateOverride: [{ address: phantom, code }],
    })
    return decodeFunctionResult({ abi: this.strategyAbi, functionName: 'check', data: data! }) as unknown as [
      { isBuy: boolean; baseAmount: bigint },
      Hex,
    ]
  }

  /// Run every sealed strategy (plus `reads`) against the state at `blockNumber`.
  ///   parallel:  one eth_call per strategy → per-strategy wall-clock timings (local demo)
  ///   multicall: everything in ONE eth_call through the gas-capped Evaluator → fits public RPCs
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
        ...reads.map((r) => ({ target: r.target, gasLimit: READ_GAS, data: r.callData })),
        ...all.map((s) => ({ target: s.phantom, gasLimit: STRATEGY_GAS, data: checkData(s) })),
      ]
      const { data } = await sim.call({
        to: EVALUATOR,
        data: encodeFunctionData({ abi: EVALUATOR_ABI, functionName: 'run', args: [calls] }),
        blockNumber,
        stateOverride: [{ address: EVALUATOR, code: this.evaluatorCode }, ...all.map((s) => ({ address: s.phantom, code: s.code }))],
      })
      const out = decodeFunctionResult({ abi: EVALUATOR_ABI, functionName: 'run', data: data! })
      const ms = performance.now() - t0
      const results = all.map((s, i) => {
        const r = out[reads.length + i]
        const gas = Number(r.gasUsed)
        if (!r.success) return this.failed(s, ms, gas, true, gas >= Number(STRATEGY_GAS) - 50_000 ? 'out of gas (1.5M cap)' : 'strategy reverted')
        return this.apply(s, r.data, ms, gas, true)
      })
      return { results, reads: out.slice(0, reads.length).map((r) => (r.success ? r.data : null)) }
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
            gas: STRATEGY_GAS,
            data: checkData(s),
            blockNumber,
            stateOverride: [{ address: s.phantom, code: s.code }],
          })
          return this.apply(s, data!, performance.now() - t0, 0, false)
        } catch (e) {
          return this.failed(s, performance.now() - t0, 0, false, (e as Error).message.split('\n')[0])
        }
      }),
    )
    return { results, reads: await readsP }
  }

  private apply(s: SealedStrategy, data: Hex, ms: number, gas: number, batched: boolean): EvalResult {
    try {
      const [order, newState] = decodeFunctionResult({
        abi: this.strategyAbi,
        functionName: 'check',
        data,
      }) as unknown as [{ isBuy: boolean; baseAmount: bigint }, Hex]
      s.state = newState // private memory, never leaves the enclave
      s.lastMs = ms
      s.lastGas = gas
      const fired = order.baseAmount > 0n
      if (fired) s.fired++
      return { id: s.id, order: fired ? order : null, ms, gas, batched }
    } catch {
      return this.failed(s, ms, gas, batched, 'bad return data')
    }
  }

  private failed(s: SealedStrategy, ms: number, gas: number, batched: boolean, error: string): EvalResult {
    s.lastMs = ms
    s.lastGas = gas
    return { id: s.id, order: null, ms, gas, batched, error }
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
