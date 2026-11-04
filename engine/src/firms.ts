// Onboards four demo trading firms. For each firm:
//   1. fund + deposit into the DarkPool vault, set a risk limit
//   2. read the enclave's attested encryption key FROM THE CHAIN (firms trust the
//      attestation, not the operator), seal strategy code + params to it
//   3. register only the commitment hash on-chain
//   4. hand the ciphertext to the engine
import { encodeAbiParameters, parseUnits, type Hex } from 'viem'
import { abis, artifact, clients, ENGINE_URL, KEYS, loadDeployment, POLL_MS, requireKey } from './config.ts'
import { seal } from './crypto.ts'
import { commitment, encodePayload, type StrategyPayload } from './sealed.ts'

const dep = loadDeployment()
const { pub, wallet } = clients(dep.chainId)
const e18 = (x: number | string) => parseUnits(String(x), 18)
const u = (xs: (number | bigint)[]) =>
  encodeAbiParameters(
    xs.map(() => ({ type: 'uint256' })),
    xs.map((x) => BigInt(x)),
  )

type FirmSetup = {
  name: string
  pk: Hex | undefined
  base: number
  quote: number
  riskLimit: number
  contract: string
  label: string
  state: Hex
}

const FIRMS: FirmSetup[] = [
  {
    name: 'Aurora Capital',
    pk: KEYS.firms[0],
    base: 20_000,
    quote: 5_000,
    riskLimit: 10_000,
    contract: 'SlicedStopLoss',
    label: 'Stop-loss @ 2.93, exit 1,200 MON / block',
    state: u([e18(2.93), e18(1_200)]),
  },
  {
    name: 'Basilisk Quant',
    pk: KEYS.firms[1],
    base: 0,
    quote: 60_000,
    riskLimit: 10_000,
    contract: 'EmaDipBuyer',
    label: 'Buy 1,000 MON / block while price < EMA(8%) − 1.5%, max 20k',
    // ema, alphaBps, dipBps, slice, maxPosition, cooldownBlocks, lastFire
    state: u([0, 800, 150, e18(1_000), e18(20_000), 1, 0]),
  },
  {
    name: 'Cobalt Trading',
    pk: KEYS.firms[2],
    base: 0,
    quote: 60_000,
    riskLimit: 10_000,
    contract: 'MomentumBreakout',
    label: 'Breakout > 3.22: accumulate 1,000 MON / block to 20k',
    // trigger, slice, target, cooldownBlocks, lastFire
    state: u([e18(3.22), e18(1_000), e18(20_000), 1, 0]),
  },
  {
    name: 'Driftwood Labs',
    pk: KEYS.firms[3],
    base: 15_000,
    quote: 0,
    riskLimit: 10_000,
    contract: 'TakeProfitLadder',
    label: 'Take profit > 3.25: sell 1,200 MON / block, keep 3k',
    // trigger, slice, floor, cooldownBlocks, lastFire
    state: u([e18(3.25), e18(1_200), e18(3_000), 1, 0]),
  },
]

async function enclaveKeyFromChain(): Promise<Buffer> {
  const signer = (await pub.readContract({ address: dep.registry, abi: abis.registry, functionName: 'latestSigner' })) as Hex
  const active = await pub.readContract({ address: dep.registry, abi: abis.registry, functionName: 'isActive', args: [signer] })
  if (!active) throw new Error('no attested enclave registered on-chain; start the engine first')
  const [, encryptionKey] = (await pub.readContract({
    address: dep.registry,
    abi: abis.registry,
    functionName: 'enclaves',
    args: [signer],
  })) as [Hex, Hex, bigint, boolean]
  console.log(`🔑 enclave ${signer} attested ✓, encryption key ${encryptionKey.slice(0, 18)}…`)
  return Buffer.from(encryptionKey.slice(2), 'hex')
}

async function onboard(f: FirmSetup, encKey: Buffer) {
  const w = wallet(requireKey(f.pk, f.name))
  const me = w.account.address
  const send = async (address: Hex, abi: typeof abis.pool, functionName: string, args: unknown[]) => {
    const hash = await w.writeContract({ address, abi, functionName, args } as never)
    return pub.waitForTransactionReceipt({ hash, pollingInterval: POLL_MS })
  }
  const read = <T>(address: Hex, abi: typeof abis.pool, functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi, functionName, args } as never) as Promise<T>

  // Reconcile vault balances to the scenario's starting point (idempotent, replayable).
  for (const [token, amt] of [
    [dep.base, f.base],
    [dep.quote, f.quote],
  ] as const) {
    const target = e18(amt)
    const bal = await read<bigint>(dep.pool, abis.pool, 'balanceOf', [me, token])
    if (bal > target) await send(dep.pool, abis.pool, 'withdraw', [token, bal - target])
    if (bal < target) {
      const need = target - bal
      const walletBal = await read<bigint>(token, abis.erc20, 'balanceOf', [me])
      if (walletBal < need) await send(token, abis.erc20, 'mint', [me, need - walletBal])
      const allowance = await read<bigint>(token, abis.erc20, 'allowance', [me, dep.pool])
      if (allowance < need) await send(token, abis.erc20, 'approve', [dep.pool, 2n ** 255n])
      await send(dep.pool, abis.pool, 'deposit', [token, need])
    }
  }
  if ((await read<bigint>(dep.pool, abis.pool, 'maxNotionalPerBatch', [me])) !== e18(f.riskLimit)) {
    await send(dep.pool, abis.pool, 'setRiskLimit', [e18(f.riskLimit)])
  }

  const code = artifact(`${f.contract}.sol`).runtime
  const payload: StrategyPayload = { firmName: f.name, label: f.label, contract: f.contract, code, initState: f.state }
  const id = commitment(code, f.state)
  const [owner, active] = await read<[Hex, boolean, bigint]>(dep.pool, abis.pool, 'strategies', [id])
  if (owner === '0x0000000000000000000000000000000000000000') await send(dep.pool, abis.pool, 'registerStrategy', [id])
  else if (owner.toLowerCase() !== me.toLowerCase()) throw new Error(`${f.name}: commitment owned by ${owner}`)
  else if (!active) await send(dep.pool, abis.pool, 'setStrategyActive', [id, true])

  // Always (re)seal to the CURRENT enclave key: enclave keys are fresh on every boot.
  const sealed = seal(encKey, encodePayload(payload))
  const res = await fetch(`${ENGINE_URL}/api/strategies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategyId: id, sealed: sealed.toString('base64') }),
  })
  if (!res.ok) throw new Error(`engine rejected ${f.name}: ${await res.text()}`)
  console.log(`🏦 ${f.name.padEnd(15)} ${me}  strategy ${id.slice(0, 12)}…  (${sealed.length} B sealed)`)
}

const encKey = await enclaveKeyFromChain()
await Promise.all(FIRMS.map((f) => onboard(f, encKey))) // independent accounts → parallel
console.log('✔ all firms onboarded. On-chain, only commitment hashes are visible.')
