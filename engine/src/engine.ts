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
import { decodeFunctionResult, encodeFunctionData, formatUnits, parseEventLogs, type Hex } from 'viem'
import {
  abis,
  address,
  ADMIN_TOKEN,
  artifact,
  clients,
  ENGINE_PORT,
  EVAL_MODE,
  EXPLORER_URL,
  IS_LOCAL,
  KEYS,
  loadDeployment,
  NETWORK,
  POLL_MS,
  requireKey,
  ROOT,
} from './config.ts'
import { Enclave, type Batch, type EvalResult, type Read } from './enclave.ts'

const dep = loadDeployment()
const { pub, sim, wsPub, wallet } = clients(dep.chainId)
const owner = wallet(requireKey(KEYS.deployer, 'deployer'))
const relayer = wallet(requireKey(KEYS.relayer, 'relayer'))
const enclave = new Enclave(artifact('IStrategy.sol', 'IStrategy').abi)

// Hosted: only the demo firms may hand strategies to this enclave (their batches spend relayer MON).
const ALLOWED_FIRMS = new Set(
  (process.env.ALLOWED_FIRMS?.split(',') ?? (IS_LOCAL ? [] : KEYS.firms.map((k) => address(requireKey(k, 'firm'))))).map((a) =>
    a.trim().toLowerCase(),
  ),
)
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
const scenario = { running: false, step: 'idle', startedAt: 0 }

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
  }
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
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, attested, blocks: stats.blocks })
    if (url.pathname === '/api/enclave') return send(res, 200, snapshot().enclave)

    if (url.pathname === '/api/strategies' && req.method === 'POST') {
      const { strategyId, sealed } = await body(req)
      // The chain, not the uploader, says who owns this commitment.
      const [firm, active] = (await pub.readContract({
        address: dep.pool,
        abi: abis.pool,
        functionName: 'strategies',
        args: [strategyId],
      })) as [Hex, boolean, bigint]
      if (firm === '0x0000000000000000000000000000000000000000' || !active) throw new Error('strategy not registered')
      if (ALLOWED_FIRMS.size && !ALLOWED_FIRMS.has(firm.toLowerCase())) return send(res, 403, { error: 'firm not allowed on this demo' })
      const s = enclave.ingest(strategyId, firm, sealed)
      console.log(`🔒 sealed strategy ${strategyId.slice(0, 10)}… from ${s.firmName} (${s.sealedSize} B ciphertext)`)
      broadcast('strategy', publicStrategy(s))
      return send(res, 200, { ok: true })
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
      if (scenario.running) return send(res, 409, { error: 'scenario already running', scenario })
      void runScenario()
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
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`))))
  })
}

function setScenario(step: string, running = scenario.running) {
  scenario.step = step
  scenario.running = running
  broadcast('scenario', scenario)
}

async function runScenario() {
  scenario.startedAt = Date.now()
  try {
    setScenario('resetting firm balances', true)
    await runScript('firms.ts')
    setScenario('market running')
    await runScript('sim.ts', { SIM_CYCLES: '1' })
    setScenario('done', false)
  } catch (e) {
    console.error('scenario failed:', (e as Error).message)
    setScenario(`failed: ${(e as Error).message}`, false)
  }
}

// ───────────────────────────── attestation ─────────────────────────────
async function attest() {
  const expected = await pub.readContract({ address: dep.registry, abi: abis.registry, functionName: 'expectedMeasurement' })
  if (expected !== enclave.measurement) {
    // Demo shortcut: the registry owner approves this build. In production this is a
    // governance action over a reproducible-build hash, done once per release.
    const h = await owner.writeContract({
      address: dep.registry,
      abi: abis.registry,
      functionName: 'approveMeasurement',
      args: [enclave.measurement],
    })
    await pub.waitForTransactionReceipt({ hash: h, pollingInterval: POLL_MS })
  }
  // Keys die with the enclave: revoke the previous boot's signer so only one is live.
  const previous = (await pub.readContract({ address: dep.registry, abi: abis.registry, functionName: 'latestSigner' })) as Hex
  const h = await relayer.writeContract({
    address: dep.registry,
    abi: abis.registry,
    functionName: 'registerEnclave',
    args: [enclave.signer.address, enclave.encryptionKey, enclave.quote()],
  })
  await pub.waitForTransactionReceipt({ hash: h, pollingInterval: POLL_MS })
  if (previous !== '0x0000000000000000000000000000000000000000') {
    const stillActive = await pub.readContract({ address: dep.registry, abi: abis.registry, functionName: 'isActive', args: [previous] })
    if (stillActive) {
      const r = await owner.writeContract({ address: dep.registry, abi: abis.registry, functionName: 'revoke', args: [previous] })
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
  const ctxBase = {
    blockNumber: n,
    timestamp,
    pool: dep.pool,
    oracle: dep.oracle,
    amm: dep.amm,
    base: dep.base,
    quote: dep.quote,
  }
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
      batched: r.batched,
      error: r.error,
      order: r.order && { isBuy: r.order.isBuy, base: fmt(r.order.baseAmount) },
    })),
    stats,
  })
  for (const r of results) if (r.error) console.warn(`strategy ${r.id.slice(0, 10)} error: ${r.error}`)

  // Mirror DarkPool.MAX_ORACLE_AGE_BLOCKS: a stale-oracle batch would only revert.
  if (orders.length > 0 && n - oracleBlock <= 25n) await submitBatch(n, oraclePx, rb, rq, orders)
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
    validUntilBlock: n + 3n, // Monad: guard on block.number (timestamps are 1s-granular)
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
      .then((r) => onReceipt(n, hash, r, { gasLimit, saved, sentAt, calldataBytes: (data.length - 2) / 2 }))
      .catch((e) => fail(n, e))
  } catch (e) {
    fail(n, e)
  }
}

function onReceipt(
  n: bigint,
  hash: Hex,
  r: Awaited<ReturnType<typeof pub.waitForTransactionReceipt>>,
  meta: { gasLimit: bigint; saved: number; sentAt: number; calldataBytes: number },
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
  const routedBase = settled.routedIsBuy ? fmt(settled.routedOut) : fmt(settled.routedIn)
  const price = fmt(settled.price)
  stats.batches++
  stats.crossedBase += crossed
  stats.routedBase += routedBase
  stats.crossedNotional += crossed * price
  stats.savedUsd += meta.saved
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
    saved: meta.saved,
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
    `✅ batch@${n} → block ${r.blockNumber} | crossed ${crossed.toFixed(0)} MON | routed ${routedBase.toFixed(0)} MON | saved $${meta.saved.toFixed(2)}`,
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

if (AUTO_ONBOARD) {
  // Enclave keys are fresh on every boot, so the demo firms re-seal to the new key.
  runScript('firms.ts').catch((e) => console.error('auto-onboard failed:', e.message))
}
