// Deploys the Vanta contracts with viem (same steps as contracts/script/Deploy.s.sol).
// Used for Monad testnet because the local Foundry build ("tempo" nightly) cannot parse
// Monad receipts.
//   NETWORK=testnet node src/deploy.ts         → plan + balance only
//   NETWORK=testnet node src/deploy.ts --yes   → deploy, write deployments/<chainId>.json
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatEther, parseEther, type Abi, type Hex } from 'viem'
import { address, artifact, CHAIN_ID, clients, KEYS, NETWORK, POLL_MS, requireKey, ROOT } from './config.ts'

const INITIAL_PRICE = parseEther(process.env.INITIAL_PRICE ?? '3')
const LIQ_BASE = parseEther('1000000')
const LIQ_QUOTE = (LIQ_BASE * INITIAL_PRICE) / 10n ** 18n

const { pub, wallet } = clients(CHAIN_ID)
const w = wallet(requireKey(KEYS.deployer, 'deployer'))
const updater = address(requireKey(KEYS.sim, 'sim'))
const bal = await pub.getBalance({ address: w.account.address })
console.log(`network ${NETWORK} (chain ${CHAIN_ID})  deployer ${w.account.address}  ${formatEther(bal)} MON`)
console.log(`oracle updater (sim) ${updater}`)
if (!process.argv.includes('--yes')) {
  console.log('plan: WMON, USDC, MockOracle, SimpleAMM (+1M/3M liquidity), EnclaveRegistry, DarkPool (~5M gas ≈ 0.6 MON)')
  console.log('dry run: re-run with --yes to deploy.')
  process.exit(0)
}

const wait = async (hash: Hex) => {
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: POLL_MS, timeout: 120_000 })
  if (r.status !== 'success') throw new Error(`tx ${hash} reverted`)
  return r
}
async function deploy(file: string, args: unknown[] = []) {
  const a = artifact(file)
  const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args } as never)
  const r = await wait(hash)
  console.log(`  ${file.replace('.sol', '').padEnd(16)} ${r.contractAddress}`)
  return r
}
const call = async (to: Hex, abi: Abi, functionName: string, args: unknown[]) =>
  wait(await w.writeContract({ address: to, abi, functionName, args } as never))

const erc20 = artifact('MockERC20.sol').abi
const baseR = await deploy('MockERC20.sol', ['Wrapped MON', 'WMON'])
const base = baseR.contractAddress!
const quote = (await deploy('MockERC20.sol', ['USD Coin', 'USDC'])).contractAddress!
const oracle = (await deploy('MockOracle.sol', [updater, INITIAL_PRICE])).contractAddress!
const amm = (await deploy('SimpleAMM.sol', [base, quote])).contractAddress!
const registry = (await deploy('EnclaveRegistry.sol')).contractAddress!
const poolR = await deploy('DarkPool.sol', [base, quote, oracle, amm, registry])
const pool = poolR.contractAddress!

console.log('  seeding AMM liquidity')
await call(base, erc20, 'mint', [w.account.address, LIQ_BASE])
await call(quote, erc20, 'mint', [w.account.address, LIQ_QUOTE])
await call(base, erc20, 'approve', [amm, LIQ_BASE])
await call(quote, erc20, 'approve', [amm, LIQ_QUOTE])
await call(amm, artifact('SimpleAMM.sol').abi, 'addLiquidity', [LIQ_BASE, LIQ_QUOTE])

const out = { chainId: CHAIN_ID, deployBlock: Number(baseR.blockNumber), base, quote, oracle, amm, registry, pool }
const path = join(ROOT, 'deployments', `${CHAIN_ID}.json`)
writeFileSync(path, JSON.stringify(out, null, 2) + '\n')
console.log(`deployed → ${path}`)
console.log(`deployer balance now ${formatEther(await pub.getBalance({ address: w.account.address }))} MON`)
