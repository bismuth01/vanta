// Market simulator: drives a scripted price path through the oracle and keeps the
// public AMM arbitraged towards it (with noise), so the demo tells a story:
//   calm → sell-off (stop-loss vs dip-buyer cross) → bottom → rally (breakout vs
//   take-profit cross) → top → mean-revert, then loops.
import { parseUnits, type Hex } from 'viem'
import { abis, ADMIN_TOKEN, clients, ENGINE_URL, IS_LOCAL, KEYS, loadDeployment, POLL_MS, requireKey, retrying } from './config.ts'

// One-line failure reason for the engine's market loop (instead of a full viem error dump).
const fatal = (e: any) => {
  if (process.env.DEBUG_FATAL) console.error(e)
  console.error(`FATAL: ${(e?.shortMessage ?? e?.message ?? String(e)).split('\n')[0]}${e?.details ? ` (${String(e.details).slice(0, 160)})` : ''}`)
  process.exit(1)
}
process.on('uncaughtException', fatal)
process.on('unhandledRejection', fatal)

const dep = loadDeployment()
const { pub, wallet } = clients(dep.chainId)
const w = wallet(requireKey(KEYS.sim, 'sim'))
const E18 = 10n ** 18n
const STEP_MS = Number(process.env.SIM_STEP_MS ?? (IS_LOCAL ? 600 : 2500)) // hosted: ~7 blocks per tick (each tick = 1–2 txs)
const CYCLES = Number(process.env.SIM_CYCLES ?? Infinity) // hosted: 1 cycle per scenario run

type Phase = { name: string; steps: number; to: number; noise: number }
const PHASES: Phase[] = [
  { name: 'Calm market', steps: 25, to: 3.0, noise: 0.002 },
  { name: 'Sell-off', steps: 28, to: 2.7, noise: 0.0015 },
  { name: 'Capitulation bottom', steps: 18, to: 2.7, noise: 0.002 },
  { name: 'Breakout rally', steps: 42, to: 3.42, noise: 0.0015 },
  { name: 'Distribution top', steps: 20, to: 3.42, noise: 0.002 },
  { name: 'Mean reversion', steps: 30, to: 3.0, noise: 0.0015 },
]

const write = async (address: Hex, abi: typeof abis.pool, functionName: string, args: unknown[]) =>
  retrying(() => w.writeContract({ address, abi, functionName, args } as never), 3, 300)

function sqrt(n: bigint) {
  if (n < 2n) return n
  let x = n
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + n / x) / 2n
  }
  return x
}

async function setup() {
  const big = parseUnits('100000000', 18)
  for (const t of [dep.base, dep.quote]) {
    const [bal, allowance] = await Promise.all([
      pub.readContract({ address: t, abi: abis.erc20, functionName: 'balanceOf', args: [w.account.address] }) as Promise<bigint>,
      pub.readContract({ address: t, abi: abis.erc20, functionName: 'allowance', args: [w.account.address, dep.amm] }) as Promise<bigint>,
    ])
    const wait = (hash: Hex) => pub.waitForTransactionReceipt({ hash, pollingInterval: POLL_MS })
    if (bal < big / 2n) await wait(await write(t, abis.erc20, 'mint', [w.account.address, big]))
    if (allowance < 2n ** 254n) await wait(await write(t, abis.erc20, 'approve', [dep.amm, 2n ** 255n]))
  }
}

/// Retail/arb flow: move the AMM spot to `target` (18-dec) with one swap.
async function arbTo(target: bigint) {
  const [rb, rq] = await Promise.all([
    pub.readContract({ address: dep.amm, abi: abis.amm, functionName: 'reserveBase' }) as Promise<bigint>,
    pub.readContract({ address: dep.amm, abi: abis.amm, functionName: 'reserveQuote' }) as Promise<bigint>,
  ])
  const k = rb * rq
  const spot = (rq * E18) / rb
  const gap = spot > target ? spot - target : target - spot
  if (gap * 10_000n < target * BigInt(process.env.SIM_ARB_BPS ?? (IS_LOCAL ? 10 : 25))) return // small gaps: not worth the gas
  const rb2 = sqrt((k * E18) / target)
  if (rb2 < rb) {
    const quoteIn = ((k / rb2 - rq) * 10_000n) / 9_970n
    if (quoteIn > E18) await write(dep.amm, abis.amm, 'swapExactIn', [dep.quote, quoteIn, 0n, w.account.address])
  } else {
    const baseIn = ((rb2 - rb) * 10_000n) / 9_970n
    if (baseIn > E18) await write(dep.amm, abis.amm, 'swapExactIn', [dep.base, baseIn, 0n, w.account.address])
  }
}

async function announce(phase: string) {
  console.log(`📈 phase: ${phase}`)
  await fetch(`${ENGINE_URL}/api/sim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
    body: JSON.stringify({ phase }),
  }).catch(() => {})
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toWad = (x: number) => parseUnits(x.toFixed(6), 18)

await setup()
let price = 3.0
for (let cycle = 0; cycle < CYCLES; cycle++) {
  for (const p of PHASES) {
    await announce(p.name)
    const from = price
    for (let i = 1; i <= p.steps; i++) {
      const t0 = Date.now()
      const trend = from + ((p.to - from) * i) / p.steps
      price = trend * (1 + (Math.random() * 2 - 1) * p.noise)
      try {
        await write(dep.oracle, abis.oracle, 'set', [toWad(price)])
        await arbTo(toWad(price * (1 + (Math.random() * 2 - 1) * 0.0015)))
      } catch (e) {
        console.warn('sim tx failed:', (e as Error).message.split('\n')[0])
      }
      await sleep(Math.max(0, STEP_MS - (Date.now() - t0)))
    }
  }
}
await announce('idle')
