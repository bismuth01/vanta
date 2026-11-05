import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  concat,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  toHex,
  webSocket,
  type Abi,
  type Hex,
} from 'viem'
import { privateKeyToAccount, nonceManager } from 'viem/accounts'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const CONTRACTS_OUT = join(ROOT, 'contracts', 'out')

// NETWORK=testnet loads engine/.env.testnet (gitignored) and applies Monad testnet defaults.
export const NETWORK = process.env.NETWORK ?? 'local'
const envFile = process.env.ENV_FILE ?? join(ROOT, 'engine', `.env.${NETWORK}`)
if (NETWORK !== 'local' && existsSync(envFile)) process.loadEnvFile(envFile)

const PRESETS: Record<string, { chainId: string; rpc: string; ws: string; explorer: string }> = {
  local: { chainId: '31337', rpc: 'http://127.0.0.1:8545', ws: 'ws://127.0.0.1:8545', explorer: '' },
  testnet: {
    chainId: '10143',
    rpc: 'https://testnet-rpc.monad.xyz',
    ws: 'wss://testnet-rpc.monad.xyz',
    explorer: 'https://testnet.monadvision.com',
  },
}
const preset = PRESETS[NETWORK] ?? PRESETS.local
const env = (k: string, d?: string) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k])
// Private keys are accepted with or without the 0x prefix.
const pkEnv = (k: string) => {
  const v = env(k)?.trim()
  return v ? ((v.startsWith('0x') ? v : `0x${v}`) as Hex) : undefined
}

export const IS_LOCAL = NETWORK === 'local'
export const CHAIN_ID = Number(env('CHAIN_ID', preset.chainId))
export const RPC_URL = env('RPC_URL', preset.rpc)!
// Empty WS_URL → HTTP polling. Monad's `newHeads` fires on *Proposed* blocks.
export const WS_URL = env('WS_URL', preset.ws) ?? ''
// Strategies run via eth_call + state override (verified on https://testnet-rpc.monad.xyz).
// Point this at a co-located Monad full node for lowest latency.
export const SIM_RPC_URL = env('SIM_RPC_URL', RPC_URL)!
export const EXPLORER_URL = env('EXPLORER_URL', preset.explorer)!
export const ENGINE_PORT = Number(env('PORT', env('ENGINE_PORT', '8787')))
export const ENGINE_URL = env('ENGINE_URL', `http://127.0.0.1:${ENGINE_PORT}`)!
export const POLL_MS = Number(env('POLL_MS', IS_LOCAL ? '50' : '250'))
// parallel: one eth_call per strategy (per-strategy timings, local demo)
// multicall: oracle + AMM + every strategy in ONE eth_call per block (public RPCs rate-limit)
export const EVAL_MODE = env('EVAL_MODE', IS_LOCAL ? 'parallel' : 'multicall') as 'parallel' | 'multicall'
// Guards the endpoints that spend MON (scenario start, phase updates). Empty = open (local only).
export const ADMIN_TOKEN = env('ADMIN_TOKEN', '')!
// Batch validity window. Public-RPC round trips (eval → estimate → send → inclusion) take
// ~1–2 s on testnet; an expired batch still pays its full gas limit on Monad.
// RPC the *browser* uses (never a private provider URL with an API key in it).
export const PUBLIC_RPC_URL = env('PUBLIC_RPC_URL', preset.rpc)!
// Guest ("bring your own strategy") policy: every guest fill spends relayer MON.
export const GUEST = {
  max: Number(env('GUEST_MAX', '6')), // concurrent guest strategies
  fills: Number(env('GUEST_FILLS', '300')), // fills per guest strategy
  ttlMin: Number(env('GUEST_TTL_MIN', '120')),
  faucetMax: Number(env('FAUCET_MAX', '40')), // vault credits in total
  faucetBase: env('FAUCET_BASE', '10000')!, // WMON credited to the guest vault
  faucetQuote: env('FAUCET_QUOTE', '30000')!, // USDC credited to the guest vault
  dripMon: env('DRIP_MON', '0.15')!, // gas money for burner wallets with < 0.05 MON
  dripMax: Number(env('DRIP_MAX', '25')),
}
// Settle once every N blocks (a ~1 s batch auction on testnet).
export const BATCH_EVERY_BLOCKS = BigInt(env('BATCH_EVERY_BLOCKS', IS_LOCAL ? '1' : '8')!)
// Hosted: the market never idles (scenario cycles repeat until an admin pauses them).
// Market loop keeps the relayer + sim wallets funded from the master wallet.
export const TOPUP = {
  below: env('TOPUP_BELOW', '1')!,
  amount: env('TOPUP_AMOUNT', '2')!,
  firmBelow: env('TOPUP_FIRM_BELOW', '0.1')!,
  firmAmount: env('TOPUP_FIRM_AMOUNT', '0.3')!,
  masterFloor: env('TOPUP_MASTER_FLOOR', '3')!, // loop pauses itself below this
}
export const MARKET_LOOP = (env('MARKET_LOOP', IS_LOCAL ? '0' : '1') ?? '0') === '1'
export const VALID_FOR_BLOCKS = BigInt(env('VALID_FOR_BLOCKS', IS_LOCAL ? '3' : '12')!)

// Anvil's well-known dev keys.
const ANVIL_KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
]

// With one funded wallet (MASTER_PK), every role gets its own deterministic key so
// processes never share nonces: role key = keccak256(master ‖ "vanta:<role>").
const MASTER_PK = pkEnv('MASTER_PK')
const derive = (role: string) => keccak256(concat([MASTER_PK!, toHex(`vanta:${role}`)]))
const key = (name: string, role: string, anvilIdx: number) =>
  (pkEnv(name) ?? (MASTER_PK ? (role === 'deployer' ? MASTER_PK : derive(role)) : IS_LOCAL ? ANVIL_KEYS[anvilIdx] : undefined)) as Hex

export const KEYS = {
  deployer: key('DEPLOYER_PK', 'deployer', 0), // registry owner + funds the others
  firms: [1, 2, 3, 4].map((i) => key(`FIRM${i}_PK`, `firm${i}`, i)),
  sim: key('SIM_PK', 'sim', 5), // oracle updater + retail flow
  relayer: key('RELAYER_PK', 'relayer', 9), // pays gas for enclave batches
}

export function requireKey(pk: Hex | undefined, what: string): Hex {
  if (!pk) throw new Error(`missing key for ${what}: set MASTER_PK in engine/.env.${NETWORK}`)
  return pk
}

export const address = (pk: Hex) => privateKeyToAccount(pk).address

/// Public Monad RPCs are load-balanced: right after a receipt, the next eth_estimateGas can land
/// on a node a block behind and revert spuriously (e.g. an approve not yet visible). Retry.
/// viem's nonce manager resets on a failed send, so retries don't leave nonce gaps.
export async function retrying<T>(fn: () => Promise<T>, tries = 5, delayMs = 600): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= tries) throw e
      await new Promise((r) => setTimeout(r, delayMs * i))
    }
  }
}

export function loadDeployment() {
  const path = join(ROOT, 'deployments', `${CHAIN_ID}.json`)
  if (!existsSync(path)) throw new Error(`No deployment at ${path}. Run the deploy script first.`)
  const d = JSON.parse(readFileSync(path, 'utf8'))
  return d as {
    chainId: number
    deployBlock: number
    base: Hex
    quote: Hex
    oracle: Hex
    amm: Hex
    registry: Hex
    pool: Hex
  }
}

export function artifact(file: string, name = file.replace(/\.sol$/, '')) {
  const a = JSON.parse(readFileSync(join(CONTRACTS_OUT, file, `${name}.json`), 'utf8'))
  return { abi: a.abi as Abi, runtime: a.deployedBytecode.object as Hex, bytecode: a.bytecode.object as Hex }
}

export const abis = {
  pool: artifact('DarkPool.sol').abi,
  registry: artifact('EnclaveRegistry.sol').abi,
  oracle: artifact('MockOracle.sol').abi,
  amm: artifact('SimpleAMM.sol').abi,
  erc20: artifact('MockERC20.sol').abi,
  strategy: artifact('IStrategy.sol', 'IStrategy').abi,
}

export function makeChain(chainId: number) {
  return defineChain({
    id: chainId,
    name: chainId === 10143 ? 'Monad Testnet' : chainId === 143 ? 'Monad' : 'Local Monad (anvil)',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL], ...(WS_URL ? { webSocket: [WS_URL] } : {}) } },
  })
}

export function clients(chainId: number) {
  const chain = makeChain(chainId)
  // Public RPCs answer bursts with HTTP 429; viem retries those with exponential backoff.
  const transport = (url: string) => http(url, { retryCount: 6, retryDelay: 200 })
  const pub = createPublicClient({ chain, transport: transport(RPC_URL), pollingInterval: POLL_MS })
  const sim = createPublicClient({ chain, transport: transport(SIM_RPC_URL) })
  const wsPub = WS_URL
    ? createPublicClient({ chain, transport: webSocket(WS_URL, { reconnect: { attempts: 1000, delay: 1000 }, keepAlive: true }) })
    : pub
  const wallet = (pk: Hex) =>
    createWalletClient({
      chain,
      transport: transport(RPC_URL),
      // Monad: eth_getTransactionCount ignores pending txs; viem's nonce manager keeps
      // max(fetched, last used + 1) locally.
      account: privateKeyToAccount(pk, { nonceManager }),
    })
  return { chain, pub, sim, wsPub, wallet }
}
