// Tops up every derived role wallet from the master wallet.
//   NETWORK=testnet node src/fund.ts            → print plan only (no transactions)
//   NETWORK=testnet node src/fund.ts --yes      → send the top-ups
//   NETWORK=testnet node src/fund.ts --address sim   → print one role's address (for scripts)
import { formatEther, parseEther, type Hex } from 'viem'
import { address, CHAIN_ID, clients, KEYS, NETWORK, requireKey } from './config.ts'

// Rough per-demo-cycle spend at ~100 gwei: relayer ≈ 1.7 MON, sim ≈ 0.8 MON, firm ≈ 0.05 MON.
const TARGETS: { role: string; pk: Hex | undefined; target: bigint }[] = [
  { role: 'relayer', pk: KEYS.relayer, target: parseEther(process.env.FUND_RELAYER ?? '2') },
  { role: 'sim', pk: KEYS.sim, target: parseEther(process.env.FUND_SIM ?? '1.2') },
  ...KEYS.firms.map((pk, i) => ({ role: `firm${i + 1}`, pk, target: parseEther(process.env.FUND_FIRM ?? '0.15') })),
]

const args = process.argv.slice(2)
if (args[0] === '--address') {
  const role = args[1]
  const pk = role === 'deployer' ? KEYS.deployer : TARGETS.find((t) => t.role === role)?.pk
  console.log(address(requireKey(pk, role)))
  process.exit(0)
}

const master = requireKey(KEYS.deployer, 'master/deployer')
const { pub, wallet } = clients(CHAIN_ID)
const w = wallet(master)
const masterBal = await pub.getBalance({ address: w.account.address })

console.log(`network ${NETWORK} (chain ${CHAIN_ID})`)
console.log(`master   ${w.account.address}  ${formatEther(masterBal)} MON\n`)

let needed = 0n
const plan: { role: string; to: Hex; amount: bigint }[] = []
for (const t of TARGETS) {
  const to = address(requireKey(t.pk, t.role))
  const bal = await pub.getBalance({ address: to })
  const top = bal < t.target ? t.target - bal : 0n
  needed += top
  if (top > 0n) plan.push({ role: t.role, to, amount: top })
  console.log(`${t.role.padEnd(8)} ${to}  ${formatEther(bal).padStart(10)} MON  → top up ${formatEther(top)}`)
}
console.log(`\ntotal top-up: ${formatEther(needed)} MON (master keeps ${formatEther(masterBal - needed)})`)

if (!args.includes('--yes')) {
  console.log('\ndry run: re-run with --yes to send.')
  process.exit(0)
}
if (needed >= masterBal) throw new Error('master balance too low for the plan (lower FUND_* targets)')
for (const p of plan) {
  const hash = await w.sendTransaction({ to: p.to, value: p.amount })
  await pub.waitForTransactionReceipt({ hash })
  console.log(`sent ${formatEther(p.amount)} MON → ${p.role} (${hash})`)
}
console.log('done.')
