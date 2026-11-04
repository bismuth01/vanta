// Vanta dashboard: vanilla JS + SVG, fed by the engine's websocket.
const $ = (id) => document.getElementById(id)
const SVGNS = 'http://www.w3.org/2000/svg'
const WINDOW = 200

const state = {
  history: [], // {n, oracle, amm, evalMs, fired}
  volume: new Map(), // includedIn block -> {crossed, routed}
  strategies: new Map(),
  results: new Map(), // strategyId -> last eval result
  settlements: [],
  stats: {},
  enclave: null,
  chainId: null,
  blockTimes: [],
  explorer: '',
  batched: false,
  adminRequired: false,
  lastBlockAt: 0,
  hoverN: null,
}

// ───────────────────────────── helpers ─────────────────────────────
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k === 'style') node.style.cssText = v
    else node.setAttribute(k, v)
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue
    node.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return node
}
function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVGNS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  return node
}
const short = (h, a = 6, b = 4) => (h ? `${h.slice(0, a)}…${h.slice(-b)}` : '—')
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })
const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
const px4 = (x) => x.toFixed(4)
const compact = (x) => (x >= 1e6 ? `${nf1.format(x / 1e6)}M` : x >= 1e4 ? `${nf1.format(x / 1e3)}k` : nf0.format(x))

// ───────────────────────────── websocket ─────────────────────────────
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  ws.onopen = () => $('conn').classList.remove('down')
  ws.onclose = () => {
    $('conn').classList.add('down')
    setTimeout(connect, 1000)
  }
  ws.onmessage = (ev) => {
    const { type, data } = JSON.parse(ev.data)
    handlers[type]?.(data)
  }
}

const handlers = {
  hello(d) {
    state.chainId = d.chainId
    state.explorer = d.explorer
    state.batched = d.evalMode === 'multicall'
    state.adminRequired = d.adminRequired
    renderScenario(d.scenario)
    state.enclave = d.enclave
    state.history = d.history
    state.stats = d.stats
    state.strategies = new Map(d.strategies.map((s) => [s.id, s]))
    state.settlements = d.settlements
    state.volume = new Map()
    for (const s of d.settlements) addVolume(s)
    setPhase(d.simPhase)
    if (d.history.length) $('block').textContent = nf0.format(d.history[d.history.length - 1].n)
    if (d.settlements.length) renderMevLast(null, d.settlements[d.settlements.length - 1])
    renderAttestation()
    renderStrategies()
    renderCommitments()
    renderFeed(true)
    renderKpis()
    scheduleCharts()
  },
  strategy(s) {
    state.strategies.set(s.id, s)
    renderStrategies()
    renderCommitments()
    renderKpis()
  },
  phase: setPhase,
  scenario: renderScenario,
  block(b) {
    const now = performance.now()
    if (state.lastBlockAt) {
      state.blockTimes.push(now - state.lastBlockAt)
      if (state.blockTimes.length > 30) state.blockTimes.shift()
    }
    state.lastBlockAt = now
    state.history.push({ n: b.n, oracle: b.oracle, amm: b.amm, evalMs: b.evalMs, fired: b.fired })
    if (state.history.length > 2000) state.history.shift()
    state.stats = b.stats
    for (const r of b.results) {
      state.results.set(r.id, r)
      const s = state.strategies.get(r.id)
      if (s) {
        s.lastMs = r.ms
        state.batched = r.batched
        if (r.order) s.fired++
      }
    }
    $('block').textContent = nf0.format(b.n)
    renderStrategies()
    renderKpis()
    scheduleCharts()
  },
  submitted(d) {
    renderMevLast(d, null)
  },
  settled({ settlement, stats }) {
    state.stats = stats
    state.settlements.push(settlement)
    if (state.settlements.length > 200) state.settlements.shift()
    addVolume(settlement)
    renderFeed(false, settlement)
    renderMevLast(null, settlement)
    renderKpis()
    scheduleCharts()
  },
  failed({ stats }) {
    state.stats = stats
    renderKpis()
  },
}

function addVolume(s) {
  const v = state.volume.get(s.includedIn) ?? { crossed: 0, routed: 0 }
  v.crossed += s.crossed
  v.routed += s.routedBase
  state.volume.set(s.includedIn, v)
}

function txLink(hash, a, b) {
  const code = el('code', {}, short(hash, a, b))
  if (!state.explorer) return code
  return el('a', { class: 'tx', href: `${state.explorer}/tx/${hash}`, target: '_blank', rel: 'noopener' }, code)
}

// ───────────────────────────── scenario control (admin) ─────────────────────────────
// Hosted demos spend testnet MON, so starting the market needs ?admin=<token> once per tab.
const adminFromUrl = new URLSearchParams(location.search).get('admin')
if (adminFromUrl) {
  sessionStorage.setItem('vanta-admin', adminFromUrl)
  history.replaceState(null, '', location.pathname)
}
const adminToken = () => sessionStorage.getItem('vanta-admin') ?? ''

function renderScenario(sc) {
  const btn = $('run-scenario')
  const canRun = !state.adminRequired || !!adminToken()
  btn.hidden = !canRun
  btn.disabled = !!sc?.running
  btn.textContent = sc?.running ? `⏳ ${sc.step}` : '▶ Run market scenario'
}

$('run-scenario').addEventListener('click', async () => {
  const res = await fetch('/api/scenario', { method: 'POST', headers: { 'x-admin-token': adminToken() } })
  if (!res.ok) alert(`Could not start scenario: ${(await res.json()).error}`)
})

function setPhase(p) {
  $('phase').textContent = p && p !== 'idle' ? `market: ${p}` : 'market idle'
}

// ───────────────────────────── header / attestation ─────────────────────────────
function renderAttestation() {
  const e = state.enclave
  const chainName = state.chainId === 10143 ? 'Monad Testnet' : state.chainId === 143 ? 'Monad Mainnet' : 'Local Monad (anvil)'
  $('chain').textContent = `${chainName} · chain ${state.chainId}`
  $('enc-signer').textContent = short(e.signer, 10, 6)
  $('enc-measure').textContent = short(e.measurement, 10, 6)
  $('enc-key').textContent = short(e.encryptionKey, 10, 6)
  $('attest-badge').classList.toggle('ok', !!e.attested)
  $('attest-text').textContent = e.attested ? 'Enclave attested on-chain' : 'Enclave NOT attested'
}

// ───────────────────────────── KPI tiles ─────────────────────────────
function renderKpis() {
  const s = state.stats
  const nStrat = state.strategies.size
  const settledVol = (s.crossedBase ?? 0) + (s.routedBase ?? 0)
  const crossPct = settledVol > 0 ? (100 * s.crossedBase) / settledVol : 0
  const lat = state.settlements.slice(-30)
  const avgLat = lat.length ? lat.reduce((a, x) => a + x.latencyMs, 0) / lat.length : 0
  const avgBlocks = lat.length ? lat.reduce((a, x) => a + (x.includedIn - x.n), 0) / lat.length : 0
  const bt = state.blockTimes.length ? state.blockTimes.reduce((a, b) => a + b, 0) / state.blockTimes.length : 0
  const gasEff = s.gasLimitTotal ? (100 * s.gasUsedTotal) / s.gasLimitTotal : 0

  const tiles = [
    { label: 'Strategy evaluations', value: compact(s.evaluations ?? 0), sub: `${nStrat} sealed × every block${bt ? ` (~${nf0.format(bt)} ms)` : ''}` },
    { label: 'Eval latency / block', value: `${nf1.format(s.avgEvalMs ?? 0)} ms`, sub: 'all strategies, in enclave' },
    { label: 'Eval → included', value: avgLat ? `${nf0.format(avgLat)} ms` : '—', sub: avgLat ? `${nf1.format(avgBlocks)} blocks after evaluation` : 'waiting for first batch' },
    { label: 'Crossed in dark pool', value: `${compact(s.crossedBase ?? 0)} MON`, sub: `${nf0.format(crossPct)}% of settled volume, zero price impact`, hero: true },
    { label: 'Slippage + fees saved', value: `$${nf2.format(s.savedUsd ?? 0)}`, sub: 'vs. sending crossed size to the AMM' },
    { label: 'Batches settled', value: nf0.format(s.batches ?? 0), sub: `${s.failed ?? 0} failed · ${s.skipped ?? 0} blocks skipped` },
    { label: 'Gas used / limit', value: gasEff ? `${nf0.format(gasEff)}%` : '—', sub: 'Monad bills the gas limit' },
  ]
  $('kpis').replaceChildren(
    ...tiles.map((t) => el('div', { class: `kpi${t.hero ? ' hero' : ''}` }, el('div', { class: 'label' }, t.label), el('div', { class: 'value' }, t.value), el('div', { class: 'sub' }, t.sub))),
  )
}

// ───────────────────────────── enclave panel ─────────────────────────────
function renderStrategies() {
  const list = [...state.strategies.values()]
  if (!list.length) return $('strategies').replaceChildren(el('div', { class: 'empty' }, 'No sealed strategies yet. Run the firm onboarding.'))
  $('strategies').replaceChildren(
    ...list.map((s) => {
      const r = state.results.get(s.id)
      const order = r?.order
      return el(
        'div',
        { class: `strat${order ? ' firing' : ''}` },
        el(
          'div',
          { class: 'row1' },
          el('span', {}, el('span', { class: 'firm' }, s.firmName), ' ', el('span', { class: 'contract' }, s.contract)),
          el('span', { class: `order${order ? '' : ' idle'}` }, order ? `${order.isBuy ? 'BUY' : 'SELL'} ${nf0.format(order.base)} MON` : 'idle'),
        ),
        el('div', { class: 'label' }, s.label),
        el(
          'div',
          { class: 'meta' },
          el('span', {}, `id ${short(s.id, 8, 4)}`),
          el('span', {}, `${nf0.format(s.codeSize)} B code`),
          el('span', {}, state.batched ? `eval ${nf1.format(s.lastMs ?? 0)} ms (1 batched call)` : `eval ${nf1.format(s.lastMs ?? 0)} ms`),
          el('span', {}, `fired ${nf0.format(s.fired)}×`),
        ),
        r?.error ? el('div', { class: 'err' }, `⚠ ${r.error}`) : null,
      )
    }),
  )
}

// ───────────────────────────── MEV view ─────────────────────────────
function renderCommitments() {
  const list = [...state.strategies.values()]
  $('commitments').replaceChildren(
    ...(list.length
      ? list.map((s) =>
          el(
            'div',
            { class: 'commitment' },
            el('code', {}, short(s.id, 10, 6)),
            el('span', {}, `owner ${short(s.firm)}`),
            el('span', { class: 'hidden' }, 'code: sealed · trigger: unknown · size: unknown'),
          ),
        )
      : [el('span', { class: 'muted' }, 'none registered')]),
  )
}

function renderMevLast(submitted, settled) {
  const box = $('mev-last')
  if (submitted) {
    box.replaceChildren(
      el('div', {}, 'Batch for block ', el('b', {}, nf0.format(submitted.n)), ' sent directly to the upcoming leaders: ', txLink(submitted.hash, 10, 6)),
      el('div', { class: 'muted' }, `${submitted.calldataBytes} B calldata: strategy hashes + sizes, valid for 3 blocks only.`),
    )
    return
  }
  const s = settled
  box.replaceChildren(
    el('div', {}, 'Landed in block ', el('b', {}, nf0.format(s.includedIn)), ` (${s.includedIn - s.n} after evaluation, ${nf0.format(s.latencyMs)} ms). `, txLink(s.hash, 10, 6)),
    el(
      'div',
      { class: 'muted' },
      `Visible only after execution: ${s.fills.length} fill(s), ${nf0.format(s.crossed)} MON crossed at the oracle price. `,
      'Strategy code, thresholds and private state: never.',
    ),
  )
}

// ───────────────────────────── settlement feed ─────────────────────────────
function feedRow(s) {
  const firmShort = (n) => (n ?? '?').split(' ')[0]
  return el(
    'tr',
    {},
    el('td', {}, el('b', {}, nf0.format(s.n)), ` → ${nf0.format(s.includedIn)}`),
    el(
      'td',
      {},
      s.fills.map((f) => el('span', { class: 'chip' }, el('span', { class: 'side' }, f.isBuy ? 'B' : 'S'), ` ${firmShort(f.firmName)} ${nf0.format(f.base)}`)),
      s.rejected.length ? el('span', { class: 'chip' }, `${s.rejected.length} rejected`) : null,
    ),
    el('td', { class: 'num' }, s.crossed > 0 ? el('b', {}, nf0.format(s.crossed)) : '0'),
    el('td', { class: 'num' }, s.routedBase > 0 ? `${nf0.format(s.routedBase)} ${s.routedIsBuy ? 'buy' : 'sell'}` : '—'),
    el('td', { class: 'num' }, s.saved > 0 ? `$${nf2.format(s.saved)}` : '—'),
    el('td', { class: 'num' }, `${nf0.format(s.gasUsed)} / ${nf0.format(s.gasLimit)}`),
    el('td', {}, txLink(s.hash, 8, 4)),
  )
}

function renderFeed(full, latest) {
  const tbody = $('feed')
  if (full) {
    tbody.replaceChildren(...state.settlements.slice(-60).reverse().map(feedRow))
  } else if (latest) {
    const row = feedRow(latest)
    row.classList.add('flash')
    tbody.prepend(row)
    while (tbody.children.length > 60) tbody.lastChild.remove()
  }
  $('feed-meta').textContent = `${state.stats.batches ?? 0} batches`
}

// ───────────────────────────── charts ─────────────────────────────
let chartQueued = false
function scheduleCharts() {
  if (chartQueued) return
  chartQueued = true
  requestAnimationFrame(() => {
    chartQueued = false
    renderCharts()
  })
}

const M = { l: 48, r: 92, t: 10, b: 22 }

function niceTicks(min, max, count) {
  const span = max - min || 1
  const step0 = span / count
  const mag = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0)
  const ticks = []
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(10))
  return ticks
}

function frame() {
  const rows = state.history.slice(-WINDOW)
  if (rows.length < 2) return null
  const n0 = rows[0].n
  const n1 = rows[rows.length - 1].n
  return { rows, n0, n1 }
}

function xScale(f, w) {
  const span = Math.max(WINDOW - 1, f.n1 - f.n0)
  const start = f.n1 - span
  return (n) => M.l + ((n - start) / span) * (w - M.l - M.r)
}

function renderCharts() {
  const f = frame()
  renderPrice(f)
  renderVolume(f)
  if (!$('table-wrap').hidden) renderTable()
}

function renderPrice(f) {
  const root = $('price-chart')
  const w = root.clientWidth
  const h = root.clientHeight
  root.replaceChildren()
  if (!f) return
  const vals = f.rows.flatMap((r) => [r.oracle, r.amm])
  let lo = Math.min(...vals)
  let hi = Math.max(...vals)
  const pad = Math.max((hi - lo) * 0.12, 0.01)
  lo -= pad
  hi += pad
  const x = xScale(f, w)
  const y = (v) => M.t + (1 - (v - lo) / (hi - lo)) * (h - M.t - M.b)

  for (const t of niceTicks(lo, hi, 6)) {
    root.append(svg('line', { class: 'grid-line', x1: M.l, x2: w - M.r, y1: y(t), y2: y(t) }))
    const tx = svg('text', { x: M.l - 8, y: y(t) + 4, 'text-anchor': 'end' })
    tx.textContent = t.toFixed(2)
    root.append(tx)
  }
  xAxis(root, f, x, h)

  const series = [
    { key: 'oracle', color: 'var(--s-oracle)', name: 'Oracle' },
    { key: 'amm', color: 'var(--s-amm)', name: 'AMM' },
  ]
  const labels = []
  for (const s of series) {
    const d = f.rows.map((r, i) => `${i ? 'L' : 'M'}${x(r.n).toFixed(1)},${y(r[s.key]).toFixed(1)}`).join('')
    root.append(svg('path', { class: 'series', d, stroke: s.color }))
    const last = f.rows[f.rows.length - 1]
    labels.push({ y: y(last[s.key]), text: `${s.name} ${px4(last[s.key])}`, cx: x(last.n), cy: y(last[s.key]), color: s.color })
  }
  // end markers + de-collided direct labels
  labels.sort((a, b) => a.y - b.y)
  if (labels.length === 2 && labels[1].y - labels[0].y < 14) {
    const mid = (labels[0].y + labels[1].y) / 2
    labels[0].y = mid - 7
    labels[1].y = mid + 7
  }
  for (const l of labels) {
    root.append(svg('circle', { cx: l.cx, cy: l.cy, r: 4, fill: l.color, stroke: 'var(--surface)', 'stroke-width': 2 }))
    const t = svg('text', { class: 'end-label', x: l.cx + 9, y: l.y + 4 })
    t.textContent = l.text
    root.append(t)
  }
  crosshair(root, f, x, w, h)
}

function renderVolume(f) {
  const root = $('volume-chart')
  const w = root.clientWidth
  const h = root.clientHeight
  root.replaceChildren()
  if (!f) return
  const x = xScale(f, w)
  const vols = f.rows.map((r) => state.volume.get(r.n) ?? { crossed: 0, routed: 0 })
  const hi = Math.max(1500, ...vols.map((v) => v.crossed + v.routed)) * 1.1
  const y = (v) => M.t + (1 - v / hi) * (h - M.t - M.b)
  const ticks = niceTicks(0, hi, 2)
  for (const t of ticks) {
    root.append(svg('line', { class: t === 0 ? 'baseline' : 'grid-line', x1: M.l, x2: w - M.r, y1: y(t), y2: y(t) }))
    const tx = svg('text', { x: M.l - 8, y: y(t) + 4, 'text-anchor': 'end' })
    tx.textContent = compact(t)
    root.append(tx)
  }
  const bw = Math.max(1.5, (w - M.l - M.r) / WINDOW - 1)
  f.rows.forEach((r, i) => {
    const v = vols[i]
    if (!v.crossed && !v.routed) return
    const cx = x(r.n) - bw / 2
    if (v.crossed) root.append(svg('rect', { class: 'bar', x: cx, width: bw, y: y(v.crossed), height: y(0) - y(v.crossed), fill: 'var(--s-cross)' }))
    if (v.routed)
      root.append(svg('rect', { class: 'bar', x: cx, width: bw, y: y(v.crossed + v.routed), height: y(v.crossed) - y(v.crossed + v.routed), fill: 'var(--s-amm)' }))
  })
  xAxis(root, f, x, h)
  crosshair(root, f, x, w, h)
}

function xAxis(root, f, x, h) {
  const step = 50
  for (let n = Math.ceil((f.n1 - WINDOW) / step) * step; n <= f.n1; n += step) {
    if (n < f.n0) continue
    const t = svg('text', { x: x(n), y: h - 4, 'text-anchor': 'middle' })
    t.textContent = `#${nf0.format(n)}`
    root.append(t)
  }
}

function crosshair(root, f, x, w, h) {
  if (state.hoverN != null && state.hoverN >= f.n0) {
    root.append(svg('line', { class: 'crosshair', x1: x(state.hoverN), x2: x(state.hoverN), y1: M.t, y2: h - M.b }))
  }
  const hit = svg('rect', { x: M.l, y: 0, width: Math.max(0, w - M.l - M.r), height: h, fill: 'transparent' })
  hit.addEventListener('pointermove', (ev) => onHover(ev, f, x))
  hit.addEventListener('pointerleave', () => {
    state.hoverN = null
    $('tooltip').hidden = true
    scheduleCharts()
  })
  root.append(hit)
}

function onHover(ev, f, x) {
  const rect = ev.currentTarget.ownerSVGElement.getBoundingClientRect()
  const px = ev.clientX - rect.left
  let best = f.rows[0]
  for (const r of f.rows) if (Math.abs(x(r.n) - px) < Math.abs(x(best.n) - px)) best = r
  state.hoverN = best.n
  const v = state.volume.get(best.n) ?? { crossed: 0, routed: 0 }
  const tip = $('tooltip')
  const row = (c, val, name) => el('div', { class: 't-row' }, el('i', { style: `--c:${c}` }), el('b', {}, val), el('span', {}, name))
  tip.replaceChildren(
    el('div', { class: 't-head' }, `Block #${nf0.format(best.n)} · eval ${nf1.format(best.evalMs)} ms`),
    row('var(--s-oracle)', px4(best.oracle), 'Oracle'),
    row('var(--s-amm)', px4(best.amm), 'AMM spot'),
    row('var(--s-cross)', `${nf0.format(v.crossed)} MON`, 'Crossed'),
    row('var(--s-amm)', `${nf0.format(v.routed)} MON`, 'Routed'),
  )
  tip.hidden = false
  const card = document.querySelector('.charts').getBoundingClientRect()
  const left = ev.clientX - card.left + 14
  tip.style.left = `${Math.min(left, card.width - 190)}px`
  tip.style.top = `${ev.clientY - card.top + 12}px`
  scheduleCharts()
}

function renderTable() {
  const rows = state.history.slice(-30).reverse()
  $('data-table').replaceChildren(
    ...rows.map((r) => {
      const v = state.volume.get(r.n) ?? { crossed: 0, routed: 0 }
      return el('tr', {}, el('td', {}, nf0.format(r.n)), el('td', {}, px4(r.oracle)), el('td', {}, px4(r.amm)), el('td', {}, nf0.format(v.crossed)), el('td', {}, nf0.format(v.routed)), el('td', {}, nf1.format(r.evalMs)))
    }),
  )
}

$('toggle-table').addEventListener('click', (e) => {
  const wrap = $('table-wrap')
  wrap.hidden = !wrap.hidden
  e.currentTarget.setAttribute('aria-pressed', String(!wrap.hidden))
  if (!wrap.hidden) renderTable()
})
window.addEventListener('resize', scheduleCharts)

renderKpis()
renderStrategies()
connect()
