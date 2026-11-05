// Vanta Sealed Strategy Engine: host process.
//   • boots the enclave and registers its attestation on-chain
//   • every new block: evaluates all sealed strategies, signs one batch, settles it
//   • serves the dashboard + a websocket event stream
//   • (hosted) re-onboards demo firms on boot and runs the market scenario on demand
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { decodeFunctionResult, encodeFunctionData, formatUnits, isAddress, parseEther, parseEventLogs, type Hex } from 'viem'
import {
  abis,
  address,
  ADMIN_TOKEN,
  artifact,
  clients,
  ENGINE_PORT,
  EVAL_MODE,
  BATCH_EVERY_BLOCKS,
  EXPLORER_URL,
  GUEST,
  MARKET_LOOP,
  TOPUP,
  PUBLIC_RPC_URL,
  IS_LOCAL,
  KEYS,
  loadDeployment,
  NETWORK,
  POLL_MS,
  requireKey,
  retrying,
  ROOT,
  VALID_FOR_BLOCKS,
} from './config.ts'
import { Enclave, type Batch, type EvalResult, type Read } from './enclave.ts'

const dep = loadDeployment()
const { pub, sim, wsPub, wallet } = clients(dep.chainId)
const owner = wallet(requireKey(KEYS.deployer, 'deployer'))
const relayer = wallet(requireKey(KEYS.relayer, 'relayer'))
const enclave = new Enclave(artifact('IStrategy.sol', 'IStrategy').abi, artifact('Evaluator.sol').runtime)

// House firms (the scripted demo) are unrestricted; every other wallet is a guest with a budget.
const HOUSE_FIRMS = new Set(KEYS.firms.filter(Boolean).map((k) => address(k!).toLowerCase()))
const AUTO_ONBOARD = (process.env.AUTO_ONBOARD ?? (IS_LOCAL ? '0' : '1')) === '1'

const E18 = 10n ** 18n
const fmt = (x: bigint, d = 18) => Number(formatUnits(x, d))

// ───────────────────────────── state for the dashboard ─────────────────────────────
type BlockRow = { n: number; oracle: number; amm: number; evalMs: number; fired: number }
const history: BlockRow[] = []
const settlements: unknown[] = []
const stats = {
  blocks: 0,
  evaluations: 0,
  skipped: 0,
  batches: 0,
  failed: 0,
  crossedBase: 0,
  routedBase: 0,
  crossedNotional: 0,
  savedUsd: 0,
  gasLimitTotal: 0,
  gasUsedTotal: 0,
  avgEvalMs: 0,
}
let simPhase = 'idle'
let attested = false
const scenario = { running: false, loop: MARKET_LOOP, cycle: 0, step: 'idle', error: '', startedAt: 0 }

// ───────────────────────────── websocket fan-out ─────────────────────────────
const server = createServer(handleHttp)
const wss = new WebSocketServer({ server, path: '/ws' })
const json = (o: unknown) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
function broadcast(type: string, data: unknown) {
  const msg = json({ type, data })
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg)
}
wss.on('connection', (ws) => ws.send(json({ type: 'hello', data: snapshot() })))

function publicStrategy(s: ReturnType<typeof enclave.strategies.get> & {}) {
  return {
    id: s.id,
    firm: s.firm,
    firmName: s.firmName,
    label: s.label,
    contract: s.contract,
    codeSize: s.codeSize,
    sealedSize: s.sealedSize,
    fired: s.fired,
    lastMs: s.lastMs,
    lastGas: s.lastGas,
    guest: s.guest,
    fillsLeft: Number.isFinite(s.fillsLeft) ? s.fillsLeft : null,
    expiresAt: Number.isFinite(s.expiresAt) ? s.expiresAt : null,
  }
}

function ctxFor(firm: Hex, blockNumber: bigint, timestamp: bigint) {
  return { blockNumber, timestamp, firm, pool: dep.pool, oracle: dep.oracle, amm: dep.amm, base: dep.base, quote: dep.quote }
}

function snapshot() {
  return {
    chainId: dep.chainId,
    network: NETWORK,
    explorer: EXPLORER_URL,
    evalMode: EVAL_MODE,
    deployment: dep,
    enclave: {
      signer: enclave.signer.address,
      measurement: enclave.measurement,
      encryptionKey: enclave.encryptionKey,
      attested,
    },
    strategies: [...enclave.strategies.values()].map(publicStrategy),
    history: history.slice(-400),
    settlements: settlements.slice(-60),
    stats,
    simPhase,
    scenario,
    adminRequired: !!ADMIN_TOKEN,
  }
}

// ───────────────────────────── http ─────────────────────────────
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString() || '{}')
}

function isAdmin(req: IncomingMessage) {
  if (!ADMIN_TOKEN) return true
  const got = Buffer.from(String(req.headers['x-admin-token'] ?? ''))
  const want = Buffer.from(ADMIN_TOKEN)
  return got.length === want.length && timingSafeEqual(got, want)
}

function send(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(json(payload))
}

async function handleHttp(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x')
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true, attested, blocks: stats.blocks })
    if (url.pathname === '/api/enclave') return send(res, 200, snapshot().enclave)

    if (url.pathname === '/api/config') return send(res, 200, publicConfig())

    if (url.pathname.startsWith('/sdk/')) {
      // Solidity SDK for the in-browser compiler (interfaces + base + templates).
      const name = url.pathname.slice(5)
      if (!SDK_FILES[name]) return send(res, 404, { error: 'unknown sdk file' })
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end(await readFile(join(ROOT, 'contracts', SDK_FILES[name])))
    }

    if (url.pathname === '/api/strategies' && req.method === 'POST') {
      const { strategyId, sealed } = await body(req)
      if (typeof strategyId !== 'string' || typeof sealed !== 'string' || sealed.length > 200_000) throw new Error('bad request')
      // The chain, not the uploader, says who owns this commitment.
      const [firm, active] = (await retrying(() =>
        pub.readContract({ address: dep.pool, abi: abis.pool, functionName: 'strategies', args: [strategyId] }),
      )) as [Hex, boolean, bigint]
      if (firm === '0x0000000000000000000000000000000000000000' || !active) throw new Error('strategy not registered on-chain (yet?)')
      const guest = !HOUSE_FIRMS.has(firm.toLowerCase())
      const opened = enclave.open(strategyId as Hex, firm, sealed)
      if (guest) {
        const guests = [...enclave.strategies.values()].filter((s) => s.guest && s.id !== strategyId)
        if (guests.length >= GUEST.max) return send(res, 429, { error: `guest slots full (${GUEST.max}); try again later` })
        // Dry-run before accepting: a guest strategy must at least execute.
        const head = await pub.getBlock()
        try {
          await enclave.probe(sim, opened.payload.code, opened.payload.initState, ctxFor(firm, head.number!, head.timestamp))
        } catch (e) {
          return send(res, 422, { error: `strategy failed its dry-run: ${(e as Error).message.split('\n')[0]}` })
        }
      }
      const s = enclave.add(strategyId as Hex, firm, opened, {
        guest,
        fillsLeft: guest ? GUEST.fills : Infinity,
        expiresAt: guest ? Date.now() + GUEST.ttlMin * 60_000 : Infinity,
      })
      console.log(`🔒 sealed ${guest ? 'GUEST' : 'house'} strategy ${strategyId.slice(0, 10)}… from ${s.firmName} (${s.sealedSize} B ciphertext)`)
      broadcast('strategy', publicStrategy(s))
      return send(res, 200, { ok: true, strategy: publicStrategy(s) })
    }

    if (url.pathname === '/api/faucet' && req.method === 'POST') {
      const { address: to } = await body(req)
      if (typeof to !== 'string' || !isAddress(to)) throw new Error('bad address')
      return send(res, 200, await faucet(to as Hex))
    }

    if (url.pathname === '/api/sim' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'admin token required' })
      simPhase = (await body(req)).phase
      broadcast('phase', simPhase)
      return send(res, 200, { ok: true })
    }

    if (url.pathname === '/api/scenario') {
      if (req.method !== 'POST') return send(res, 200, scenario)
      if (!isAdmin(req)) return send(res, 401, { error: 'admin token required' })
      const { action = 'start' } = await body(req).catch(() => ({}))
      if (action === 'pause') {
        scenario.loop = false
        setScenario(scenario.running ? 'pausing after this cycle' : 'paused')
        return send(res, 200, scenario)
      }
      if (action === 'loop') {
        scenario.loop = true
        if (!scenario.running) void runMarket()
        setScenario(scenario.running ? scenario.step : 'starting loop')
        return send(res, 200, scenario)
      }
      if (scenario.running) return send(res, 409, { error: 'scenario already running', scenario })
      void runMarket()
      return send(res, 202, scenario)
    }

    const file = url.pathname === '/' ? '/index.html' : url.pathname
    if (file.includes('..')) throw new Error('bad path')
    const content = await readFile(join(ROOT, 'dashboard', file))
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(content)
  } catch (e) {
    send(res, 400, { error: (e as Error).message })
  }
}

// ───────────────────────────── bring-your-own-strategy support ─────────────────────────────
const SDK_FILES: Record<string, string> = {
  'IStrategy.sol': 'src/interfaces/IStrategy.sol',
  'StrategyBase.sol': 'src/strategies/StrategyBase.sol',
  'templates/RangeLiquidityProvider.sol': 'src/strategies/RangeLiquidityProvider.sol',
  'templates/SlicedStopLoss.sol': 'src/strategies/SlicedStopLoss.sol',
  'templates/MomentumBreakout.sol': 'src/strategies/MomentumBreakout.sol',
}

function publicConfig() {
  return {
    chainId: dep.chainId,
    network: NETWORK,
    rpcUrl: PUBLIC_RPC_URL,
    explorer: EXPLORER_URL,
    deployment: dep,
    enclave: { signer: enclave.signer.address, registry: dep.registry },
    guest: { max: GUEST.max, fills: GUEST.fills, ttlMin: GUEST.ttlMin, faucetBase: GUEST.faucetBase, faucetQuote: GUEST.faucetQuote },
    abis: { pool: abis.pool, registry: abis.registry, strategy: abis.strategy, oracle: abis.oracle },
  }
}

// Demo faucet: credits the guest's *vault* directly (DarkPool.depositFor), so the guest needs no
// token transactions at all; burner wallets also get a little MON for their one registration tx.
const faucetDone = new Set<string>()
let faucetCount = 0
let dripCount = 0
let faucetQueue: Promise<unknown> = Promise.resolve()
const faucetBase = parseEther(GUEST.faucetBase)
const faucetQuote = parseEther(GUEST.faucetQuote)

function faucet(to: Hex) {
  const run = async () => {
    const key = to.toLowerCase()
    const result: { credited: boolean; dripped: boolean; txs: Hex[]; note?: string } = { credited: false, dripped: false, txs: [] }
    const wait = (hash: Hex) => pub.waitForTransactionReceipt({ hash, pollingInterval: POLL_MS, timeout: 60_000 })
    const write = async (address: Hex, abi: typeof abis.pool, functionName: string, args: unknown[]) => {
      const hash = await retrying(() => owner.writeContract({ address, abi, functionName, args } as never))
      result.txs.push(hash)
      return wait(hash)
    }

    if (faucetDone.has(key)) result.note = 'vault already credited for this wallet'
    else if (faucetCount >= GUEST.faucetMax) result.note = 'faucet exhausted'
    else {
      for (const [token, amount] of [
        [dep.base, faucetBase],
        [dep.quote, faucetQuote],
      ] as const) {
        const [bal, allowance] = (await Promise.all([
          pub.readContract({ address: token, abi: abis.erc20, functionName: 'balanceOf', args: [owner.account.address] }),
          pub.readContract({ address: token, abi: abis.erc20, functionName: 'allowance', args: [owner.account.address, dep.pool] }),
        ])) as [bigint, bigint]
        if (bal < amount) await write(token, abis.erc20, 'mint', [owner.account.address, amount * 100n])
        if (allowance < amount) await write(token, abis.erc20, 'approve', [dep.pool, 2n ** 255n])
        await write(dep.pool, abis.pool, 'depositFor', [to, token, amount])
      }
      faucetDone.add(key)
      faucetCount++
      result.credited = true
    }

    const mon = await pub.getBalance({ address: to })
    if (mon < parseEther('0.05') && dripCount < GUEST.dripMax) {
      const hash = await retrying(() => relayer.sendTransaction({ to, value: parseEther(GUEST.dripMon) }))
      result.txs.push(hash)
      await wait(hash)
      dripCount++
      result.dripped = true
    }
    console.log(`🚰 faucet ${to}: vault ${result.credited ? 'credited' : 'skipped'}${result.dripped ? ', dripped MON' : ''}`)
    return result
  }
  const p = faucetQueue.then(run, run)
  faucetQueue = p.catch(() => {})
  return p
}

/// Guest budget + expiry. Returns the orders allowed into this batch.
function applyGuestPolicy<T extends { id: Hex }>(orders: T[]): T[] {
  const now = Date.now()
  for (const s of [...enclave.strategies.values()]) {
    if (s.guest && now > s.expiresAt) {
      enclave.remove(s.id)
      pending.delete(s.id)
      broadcast('strategyRemoved', { id: s.id, reason: 'expired' })
      console.log(`⌛ guest strategy ${s.id.slice(0, 10)}… expired`)
    }
  }
  return orders.filter((o) => {
    const s = enclave.strategies.get(o.id)
    if (!s) return false
    if (!s.guest) return true
    if (s.fillsLeft <= 0) return false
    s.fillsLeft--
    broadcast('strategy', publicStrategy(s))
    return true
  })
}

// ───────────────────────────── child scripts (firms, market sim) ─────────────────────────────
function runScript(script: string, extraEnv: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'engine', 'src', script)], {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const tag = script.replace('.ts', '')
    child.stdout.on('data', (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, `[${tag}] `)))
    child.stderr.on('data', (d) => process.stderr.write(String(d).replace(/^(?=.)/gm, `[${tag}] `)))
    let fatal = ''
    child.stderr.on('data', (d) => {
      const m = String(d).match(/FATAL: (.*)/)
      if (m) fatal = m[1]
    })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script.replace('.ts', '')}: ${fatal || `exited with ${code}`}`))))
  })
}

function setScenario(step: string, running = scenario.running) {
  scenario.step = step
  scenario.running = running
  broadcast('scenario', scenario)
}

/// Keep the wallets that pay gas for the always-on market funded from the master wallet.
async function topUpOperators() {
  if (IS_LOCAL) return
  const master = await pub.getBalance({ address: owner.account.address })
  if (master < parseEther(TOPUP.masterFloor)) {
    throw new Error(`master wallet low (${Number(formatUnits(master, 18)).toFixed(2)} MON < ${TOPUP.masterFloor}); fund ${owner.account.address}`)
  }
  const wallets: [string, Hex | undefined, string, string][] = [
    ['relayer', KEYS.relayer, TOPUP.below, TOPUP.amount],
    ['sim', KEYS.sim, TOPUP.below, TOPUP.amount],
    ...KEYS.firms.map((k, i) => [`firm${i + 1}`, k, TOPUP.firmBelow, TOPUP.firmAmount] as [string, Hex | undefined, string, string]),
  ]
  for (const [role, pk, below, amount] of wallets) {
    const to = address(requireKey(pk, role))
    const bal = await pub.getBalance({ address: to })
    if (bal >= parseEther(below)) continue
    const hash = await retrying(() => owner.sendTransaction({ to, value: parseEther(amount) }))
    await pub.waitForTransactionReceipt({ hash, pollingInterval: POLL_MS })
    console.log(`⛽ topped up ${role} with ${amount} MON`)
  }
}

/// One scenario cycle = reset house-firm balances + one scripted market cycle.
/// With scenario.loop the market never idles: cycles repeat until paused.
async function runMarket() {
  scenario.startedAt = Date.now()
  scenario.running = true
  scenario.error = ''
  let failures = 0
  do {
    scenario.cycle++
    try {
      setScenario(`cycle ${scenario.cycle}: checking gas wallets`)
      await topUpOperators()
      setScenario(`cycle ${scenario.cycle}: resetting firm balances`)
      await runScript('firms.ts')
      setScenario(`cycle ${scenario.cycle}: market running`)
      await runScript('sim.ts', { SIM_CYCLES: '1' })
      failures = 0
      scenario.error = ''
    } catch (e) {
      failures++
      scenario.error = (e as Error).message.slice(0, 200)
      console.error(`market cycle failed (${failures}/3):`, scenario.error)
      setScenario(`cycle ${scenario.cycle} failed: ${scenario.error}`)
      if (failures >= 3 || /master wallet low/.test(scenario.error)) {
        scenario.loop = false
        break
      }
      await new Promise((r) => setTimeout(r, 10_000))
    }
  } while (scenario.loop)
  setScenario(scenario.error ? `stopped: ${scenario.error}` : 'done', false)
}

// ───────────────────────────── attestation ─────────────────────────────
async function attest() {
  const expected = await pub.readContract({ address: dep.registry, abi: abis.registry, functionName: 'expectedMeasurement' })
  if (expected !== enclave.measurement) {
    // Demo shortcut: the registry owner approves this build. In production this is a
    // governance action over a reproducible-build hash, done once per release.
    const h = await retrying(() => owner.writeContract({
      address: dep.registry,
      abi: abis.registry,
      functionName: 'approveMeasurement',
      args: [enclave.measurement],
    }))
    await pub.waitForTransactionReceipt({ hash: h, pollingInterval: POLL_MS })
  }
  // Keys die with the enclave: revoke the previous boot's signer so only one is live.
  const previous = (await pub.readContract({ address: dep.registry, abi: abis.registry, functionName: 'latestSigner' })) as Hex
  const h = await retrying(() => relayer.writeContract({
    address: dep.registry,
    abi: abis.registry,
    functionName: 'registerEnclave',
    args: [enclave.signer.address, enclave.encryptionKey, enclave.quote()],
  }))
  await pub.waitForTransactionReceipt({ hash: h, pollingInterval: POLL_MS })
  if (previous !== '0x0000000000000000000000000000000000000000') {
    const stillActive = await pub.readContract({ address: dep.registry, abi: abis.registry, functionName: 'isActive', args: [previous] })
    if (stillActive) {
      const r = await retrying(() => owner.writeContract({ address: dep.registry, abi: abis.registry, functionName: 'revoke', args: [previous] }))
      await pub.waitForTransactionReceipt({ hash: r, pollingInterval: POLL_MS })
      console.log(`   revoked previous enclave ${previous}`)
    }
  }
  attested = (await pub.readContract({
    address: dep.registry,
    abi: abis.registry,
    functionName: 'isActive',
    args: [enclave.signer.address],
  })) as boolean

  // Self-test: local digest must match the contract's.
  const probe: Batch = { batchId: 1n, validUntilBlock: 2n, price: 3n * E18, fills: [{ strategyId: enclave.measurement, isBuy: true, baseAmount: 1n }] }
  const onchain = await pub.readContract({ address: dep.pool, abi: abis.pool, functionName: 'batchDigest', args: [probe] })
  if (onchain !== enclave.digest(dep.chainId, dep.pool, probe)) throw new Error('batch digest mismatch')
}

// ───────────────────────────── per-block loop ─────────────────────────────
let busy = false
const pending = new Map<Hex, EvalResult & { order: NonNullable<EvalResult['order']> }>()
let windowStart = 0n

async function onBlock(n: bigint, timestamp: bigint) {
  if (busy) {
    stats.skipped++
    return
  }
  busy = true
  try {
    await evaluateBlock(n, timestamp)
  } catch (e) {
    console.error('block', n, (e as Error).message.split('\n')[0])
  } finally {
    busy = false
  }
}

const READS: Read[] = [
  { target: dep.oracle, callData: encodeFunctionData({ abi: abis.oracle, functionName: 'latest' }) },
  { target: dep.amm, callData: encodeFunctionData({ abi: abis.amm, functionName: 'reserveBase' }) },
  { target: dep.amm, callData: encodeFunctionData({ abi: abis.amm, functionName: 'reserveQuote' }) },
]
const decodeRead = (abi: typeof abis.amm, functionName: string, data: Hex | null) => {
  if (!data) throw new Error(`read ${functionName} failed`)
  return decodeFunctionResult({ abi, functionName, data } as never) as unknown
}

/// SimpleAMM.getAmountOut, computed locally from the reserves read this block.
const ammOut = (amountIn: bigint, rIn: bigint, rOut: bigint) => {
  const inWithFee = amountIn * 9_970n
  return (inWithFee * rOut) / (rIn * 10_000n + inWithFee)
}

async function evaluateBlock(n: bigint, timestamp: bigint) {
  const t0 = performance.now()
  const { firm: _, ...ctxBase } = ctxFor('0x0000000000000000000000000000000000000000', n, timestamp)
  const { results, reads } = await enclave.evaluate(sim, n, ctxBase, EVAL_MODE, READS)
  const [oraclePx, oracleBlock] = decodeRead(abis.oracle, 'latest', reads[0]) as [bigint, bigint]
  const rb = decodeRead(abis.amm, 'reserveBase', reads[1]) as bigint
  const rq = decodeRead(abis.amm, 'reserveQuote', reads[2]) as bigint
  const evalMs = performance.now() - t0
  const orders = results.filter((r): r is EvalResult & { order: NonNullable<EvalResult['order']> } => !!r.order)

  stats.blocks++
  stats.evaluations += results.length
  stats.avgEvalMs = stats.avgEvalMs === 0 ? evalMs : stats.avgEvalMs * 0.95 + evalMs * 0.05
  const row: BlockRow = { n: Number(n), oracle: fmt(oraclePx), amm: fmt((rq * E18) / rb), evalMs, fired: orders.length }
  history.push(row)
  if (history.length > 2000) history.shift()
  broadcast('block', {
    ...row,
    results: results.map((r) => ({
      id: r.id,
      ms: r.ms,
      gas: r.gas,
      batched: r.batched,
      error: r.error,
      order: r.order && { isBuy: r.order.isBuy, base: fmt(r.order.baseAmount) },
    })),
    stats,
  })
  for (const r of results) if (r.error) console.warn(`strategy ${r.id.slice(0, 10)} error: ${r.error}`)

  // Mirror DarkPool.MAX_ORACLE_AGE_BLOCKS: a stale-oracle batch would only revert.
  // Batch window: keep each strategy's latest intent and settle once every BATCH_EVERY_BLOCKS.
  // Fewer txs (Monad bills the gas limit) and more crossing between neighbouring blocks.
  for (const r of results) {
    if (r.order) pending.set(r.id, r as EvalResult & { order: NonNullable<EvalResult['order']> })
    else pending.delete(r.id)
  }
  if (windowStart === 0n) windowStart = n
  if (n - windowStart + 1n < BATCH_EVERY_BLOCKS) return
  windowStart = 0n
  const window = [...pending.values()]
  pending.clear()
  if (window.length > 0 && n - oracleBlock <= 25n) {
    const allowed = applyGuestPolicy(window)
    if (allowed.length > 0) await submitBatch(n, oraclePx, rb, rq, allowed)
  }
}

async function submitBatch(
  n: bigint,
  px: bigint,
  rb: bigint,
  rq: bigint,
  orders: (EvalResult & { order: { isBuy: boolean; baseAmount: bigint } })[],
) {
  const batch: Batch = {
    batchId: n,
    validUntilBlock: n + VALID_FOR_BLOCKS, // Monad: guard on block.number (timestamps are 1s-granular)
    price: px,
    fills: orders.map((o) => ({ strategyId: o.id, isBuy: o.order.isBuy, baseAmount: o.order.baseAmount })),
  }
  const totalBuy = batch.fills.filter((f) => f.isBuy).reduce((a, f) => a + f.baseAmount, 0n)
  const totalSell = batch.fills.filter((f) => !f.isBuy).reduce((a, f) => a + f.baseAmount, 0n)
  const crossed = totalBuy < totalSell ? totalBuy : totalSell

  // What the crossed size would have cost on the public AMM, for both sides.
  const saved =
    crossed > 0n
      ? fmt((crossed * px) / E18 - ammOut(crossed, rb, rq)) + fmt(((crossed - ammOut((crossed * px) / E18, rq, rb)) * px) / E18)
      : 0

  const signature = await enclave.sign(dep.chainId, dep.pool, batch)
  const data = encodeFunctionData({ abi: abis.pool, functionName: 'settle', args: [batch, signature] })
  const fills = batch.fills.map((f) => {
    const s = enclave.strategies.get(f.strategyId)!
    return { id: f.strategyId, firm: s.firm, firmName: s.firmName, isBuy: f.isBuy, base: fmt(f.baseAmount) }
  })

  try {
    const gas = await pub.estimateGas({ account: relayer.account, to: dep.pool, data })
    // Monad charges the gas LIMIT, not gas used → keep the margin tight.
    const gasLimit = (gas * 115n) / 100n
    const sentAt = performance.now()
    const hash = await relayer.sendTransaction({ to: dep.pool, data, gas: gasLimit })
    broadcast('submitted', { n: Number(n), hash, fills, crossed: fmt(crossed), calldataBytes: (data.length - 2) / 2 })

    pub
      .waitForTransactionReceipt({ hash, pollingInterval: POLL_MS, timeout: 60_000 })
      .then((r) => onReceipt(n, hash, r, { gasLimit, saved, previewCrossed: fmt(crossed), sentAt, calldataBytes: (data.length - 2) / 2 }))
      .catch((e) => fail(n, e))
  } catch (e) {
    fail(n, e)
  }
}

function onReceipt(
  n: bigint,
  hash: Hex,
  r: Awaited<ReturnType<typeof pub.waitForTransactionReceipt>>,
  meta: { gasLimit: bigint; saved: number; previewCrossed: number; sentAt: number; calldataBytes: number },
) {
  if (r.status !== 'success') return fail(n, new Error('reverted on-chain'))
  const logs = parseEventLogs({ abi: abis.pool, logs: r.logs }) as unknown as { eventName: string; args: Record<string, any> }[]
  const settled = logs.find((l) => l.eventName === 'BatchSettled')!.args
  const filled = logs
    .filter((l) => l.eventName === 'Filled')
    .map((l) => ({
      id: l.args.strategyId,
      firm: l.args.firm,
      firmName: enclave.strategies.get(l.args.strategyId)?.firmName,
      isBuy: l.args.isBuy,
      base: fmt(l.args.baseAmount),
      quote: fmt(l.args.quoteAmount),
      crossed: fmt(l.args.crossedBase),
    }))
  const rejected = logs.filter((l) => l.eventName === 'FillRejected').map((l) => ({ id: l.args.strategyId, reason: Number(l.args.reason) }))

  const crossed = fmt(settled.crossedBase)
  // Fills can be rejected on-chain (e.g. balance already spent by a batch in flight): only
  // count savings for what actually crossed.
  const saved = meta.previewCrossed > 0 ? (meta.saved * Math.min(crossed, meta.previewCrossed)) / meta.previewCrossed : 0
  const routedBase = settled.routedIsBuy ? fmt(settled.routedOut) : fmt(settled.routedIn)
  const price = fmt(settled.price)
  stats.batches++
  stats.crossedBase += crossed
  stats.routedBase += routedBase
  stats.crossedNotional += crossed * price
  stats.savedUsd += saved
  stats.gasLimitTotal += Number(meta.gasLimit)
  stats.gasUsedTotal += Number(r.gasUsed)

  const s = {
    n: Number(n),
    includedIn: Number(r.blockNumber),
    hash,
    price,
    crossed,
    routedBase,
    routedIsBuy: settled.routedIsBuy,
    saved,
    gasUsed: Number(r.gasUsed),
    gasLimit: Number(meta.gasLimit),
    latencyMs: performance.now() - meta.sentAt,
    calldataBytes: meta.calldataBytes,
    fills: filled,
    rejected,
  }
  settlements.push(s)
  if (settlements.length > 200) settlements.shift()
  broadcast('settled', { settlement: s, stats })
  console.log(
    `✅ batch@${n} → block ${r.blockNumber} | crossed ${crossed.toFixed(0)} MON | routed ${routedBase.toFixed(0)} MON | saved $${saved.toFixed(2)}`,
  )
}

function fail(n: bigint, e: unknown) {
  stats.failed++
  const reason = ((e as Error).message ?? String(e)).split('\n').find((l) => /reverted|reason|Error/i.test(l)) ?? String(e)
  broadcast('failed', { n: Number(n), reason: reason.slice(0, 160), stats })
  console.warn(`✗ batch@${n}: ${reason.slice(0, 160)}`)
}

// ───────────────────────────── boot ─────────────────────────────
console.log(`🛡  Vanta enclave booting (network ${NETWORK}, chain ${dep.chainId}, eval mode ${EVAL_MODE})`)
console.log(`   measurement    ${enclave.measurement}`)
console.log(`   signer         ${enclave.signer.address}`)
console.log(`   encryption key ${enclave.encryptionKey}`)
await attest()
console.log(`   attested on-chain: ${attested ? 'yes' : 'NO'} (registry ${dep.registry})`)

server.listen(ENGINE_PORT, () => console.log(`📊 dashboard  http://127.0.0.1:${ENGINE_PORT}`))

// newHeads fires on *Proposed* blocks on Monad (speculative). On-chain guards make a
// trigger on an abandoned proposal revert instead of mis-filling.
wsPub.watchBlocks({
  emitMissed: false,
  onBlock: (b) => void onBlock(b.number!, b.timestamp),
  onError: (e) => console.error('block watcher:', e.message.split('\n')[0]),
})

if (scenario.loop) {
  // Always-on market: each cycle re-onboards/resets the house firms, so this also seals them.
  void runMarket()
} else if (AUTO_ONBOARD) {
  // Enclave keys are fresh on every boot, so the demo firms re-seal to the new key.
  runScript('firms.ts').catch((e) => console.error('auto-onboard failed:', e.message))
}
