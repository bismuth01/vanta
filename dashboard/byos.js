// Bring-your-own-strategy: connect a wallet, write/compile a Solidity strategy in the browser,
// dry-run it on live Monad, seal it to the attested enclave key (read from the chain) and go
// live with ONE transaction. Source and bytecode never leave the browser unencrypted.
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionResult,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  http,
  keccak256,
  parseEther,
  toHex,
} from 'https://esm.sh/viem@2.57.16'
import { generatePrivateKey, privateKeyToAccount } from 'https://esm.sh/viem@2.57.16/accounts'
import { x25519 } from 'https://esm.sh/@noble/curves@1.9.7/ed25519'
import { hkdf } from 'https://esm.sh/@noble/hashes@1.8.0/hkdf'
import { sha256 } from 'https://esm.sh/@noble/hashes@1.8.0/sha2'

const SOLC = 'soljson-v0.8.28+commit.7893614a.js'
const ZERO = '0x0000000000000000000000000000000000000000'
const PHANTOM = '0x5ea1ed000000000000000000000000000000beef'
const $ = (id) => document.getElementById(id)
const short = (h, a = 6, b = 4) => (h ? `${h.slice(0, a)}…${h.slice(-b)}` : '—')
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

const S = {
  cfg: null,
  chain: null,
  pub: null,
  wallet: null,
  account: null, // address
  kind: null, // 'injected' | 'burner'
  compiled: null, // { contract, code, size }
  strategyId: null,
  active: true,
  myFills: [],
  sdk: null,
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else node.setAttribute(k, v)
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)))
  return node
}

function status(id, kind, ...content) {
  const box = $(id)
  box.className = `byos-status ${kind}`
  box.replaceChildren(...content)
  box.hidden = false
}

const txLink = (hash) =>
  S.cfg.explorer ? el('a', { href: `${S.cfg.explorer}/tx/${hash}`, target: '_blank', rel: 'noopener' }, short(hash, 10, 6)) : el('code', {}, short(hash, 10, 6))

// ───────────────────────────── templates ─────────────────────────────
const TEMPLATES = {
  range: { name: 'Range Liquidity Provider (demo)', url: '/sdk/templates/RangeLiquidityProvider.sol', label: 'Range LP: buy dips, sell rips (levels sealed)' },
  nibbler: {
    name: 'Minimal: dip nibbler',
    label: 'Buy 500 MON every 5 blocks below 2.95',
    source: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StrategyBase, Context, Order} from "./StrategyBase.sol";

/// Buy 500 MON every 5 blocks while MON trades below 2.95 USDC.
/// Sealed strategies never run a constructor: parameters are constants, memory lives in \`state\`.
contract DipNibbler is StrategyBase {
    uint256 constant BELOW = 2.95e18;
    uint256 constant SLICE = 500e18;
    uint256 constant EVERY = 5;

    function check(Context calldata ctx, bytes calldata state) external view returns (Order memory, bytes memory) {
        uint256 last = state.length == 0 ? 0 : abi.decode(state, (uint256));
        uint256 px = _price(ctx);
        if (ctx.blockNumber < last + EVERY || px >= BELOW) return _none(state);
        uint256 size = _min(SLICE, _affordable(ctx, px));
        if (_isDust(size, SLICE)) return _none(state);
        return (Order(true, size), abi.encode(ctx.blockNumber));
    }
}
`,
  },
}

async function loadTemplate(key) {
  const t = TEMPLATES[key]
  const src = t.source ?? (await (await fetch(t.url)).text())
  $('byos-code').value = src
  $('byos-label').value = t.label
  invalidateCompile()
}

// ───────────────────────────── wallet ─────────────────────────────
async function ensureChain() {
  const chainId = toHex(S.cfg.chainId)
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
  } catch (e) {
    if (e.code !== 4902 && !/unrecognized|not been added|unknown chain/i.test(e.message ?? '')) throw e
    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: S.chain.name,
          nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
          rpcUrls: [S.cfg.rpcUrl],
          blockExplorerUrls: S.cfg.explorer ? [S.cfg.explorer] : [],
        },
      ],
    })
  }
}

async function connectInjected() {
  if (!window.ethereum) {
    status('byos-wallet-status', 'warn', 'No browser wallet found. Use a burner wallet instead (it gets gas from the demo faucet).')
    return
  }
  try {
    status('byos-wallet-status', 'busy', 'Waiting for your wallet…')
    const [addr] = await window.ethereum.request({ method: 'eth_requestAccounts' })
    await ensureChain()
    S.wallet = createWalletClient({ chain: S.chain, transport: custom(window.ethereum), account: addr })
    S.account = addr
    S.kind = 'injected'
    window.ethereum.on?.('accountsChanged', () => location.reload())
    window.ethereum.on?.('chainChanged', () => location.reload())
    await afterConnect()
  } catch (e) {
    status('byos-wallet-status', 'err', `Wallet error: ${e.shortMessage ?? e.message}`)
  }
}

async function connectBurner() {
  let pk = localStorage.getItem('vanta-burner')
  if (!pk) {
    pk = generatePrivateKey()
    localStorage.setItem('vanta-burner', pk)
  }
  const account = privateKeyToAccount(pk)
  S.wallet = createWalletClient({ chain: S.chain, transport: http(S.cfg.rpcUrl), account })
  S.account = account.address
  S.kind = 'burner'
  await afterConnect()
}

async function afterConnect() {
  window.vantaMe = S.account.toLowerCase()
  window.dispatchEvent(new CustomEvent('vanta:me', { detail: S.account }))
  const mon = await S.pub.getBalance({ address: S.account })
  status(
    'byos-wallet-status',
    'ok',
    el('b', {}, short(S.account, 8, 6)),
    ` · ${Number(formatEther(mon)).toFixed(3)} MON · ${S.chain.name} · `,
    S.kind === 'burner' ? 'burner wallet (key in this browser only)' : 'browser wallet',
  )
  document.querySelectorAll('.byos-needs-wallet').forEach((b) => (b.disabled = false))
  const saved = localStorage.getItem(`vanta-strategy:${S.cfg.deployment.pool}:${S.account.toLowerCase()}`)
  if (saved) S.strategyId = saved
  await refreshVault()
  if (S.strategyId) await showLive(true)
}

// ───────────────────────────── compile + dry-run ─────────────────────────────
let worker = null
let compileSeq = 0
function compileInWorker(input) {
  worker ??= new Worker('/solc-worker.js')
  const id = ++compileSeq
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      if (e.data.id !== id) return
      worker.removeEventListener('message', onMsg)
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.output)
    }
    worker.addEventListener('message', onMsg)
    worker.postMessage({ id, version: SOLC, input })
  })
}

function invalidateCompile() {
  S.compiled = null
  $('byos-dryrun').disabled = true
  $('byos-seal').disabled = true
  $('byos-compile-status').hidden = true
  $('byos-dryrun-status').hidden = true
}

async function compile() {
  const t0 = performance.now()
  status('byos-compile-status', 'busy', worker ? 'Compiling…' : 'Loading the Solidity compiler (≈9 MB, first time only) and compiling…')
  $('byos-compile').disabled = true
  try {
    S.sdk ??= {
      IStrategy: await (await fetch('/sdk/IStrategy.sol')).text(),
      StrategyBase: await (await fetch('/sdk/StrategyBase.sol')).text(),
    }
    const file = 'src/strategies/MyStrategy.sol'
    const out = await compileInWorker({
      language: 'Solidity',
      sources: {
        'src/interfaces/IStrategy.sol': { content: S.sdk.IStrategy },
        'src/strategies/StrategyBase.sol': { content: S.sdk.StrategyBase },
        [file]: { content: $('byos-code').value },
      },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        viaIR: true,
        evmVersion: 'prague',
        outputSelection: { [file]: { '*': ['abi', 'evm.deployedBytecode.object'] } },
      },
    })
    const errors = (out.errors ?? []).filter((e) => e.severity === 'error')
    if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'))
    const found = Object.entries(out.contracts?.[file] ?? {}).find(
      ([, c]) => c.evm.deployedBytecode.object.length > 0 && c.abi.some((f) => f.type === 'function' && f.name === 'check'),
    )
    if (!found) throw new Error('No deployable contract with check(Context, bytes) found. Extend StrategyBase or implement IStrategy.')
    const [contract, c] = found
    S.compiled = { contract, code: `0x${c.evm.deployedBytecode.object}`, size: c.evm.deployedBytecode.object.length / 2 }
    status('byos-compile-status', 'ok', '✓ ', el('b', {}, contract), ` · ${nf0.format(S.compiled.size)} B runtime · ${((performance.now() - t0) / 1000).toFixed(1)} s · compiled in your browser`)
    $('byos-dryrun').disabled = false
    $('byos-seal').disabled = !S.account
  } catch (e) {
    status('byos-compile-status', 'err', el('pre', {}, e.message))
  } finally {
    $('byos-compile').disabled = false
  }
}

const initState = () => ($('byos-state').value.trim() || '0x')

async function dryRun() {
  status('byos-dryrun-status', 'busy', 'Running on live chain state…')
  try {
    const d = S.cfg.deployment
    const [block, [px]] = await Promise.all([
      S.pub.getBlock(),
      S.pub.readContract({ address: d.oracle, abi: S.cfg.abis.oracle, functionName: 'latest' }),
    ])
    const ctx = { blockNumber: block.number, timestamp: block.timestamp, firm: S.account ?? ZERO, pool: d.pool, oracle: d.oracle, amm: d.amm, base: d.base, quote: d.quote }
    const t0 = performance.now()
    const { data } = await S.pub.call({
      to: PHANTOM,
      gas: 1_500_000n,
      data: encodeFunctionData({ abi: S.cfg.abis.strategy, functionName: 'check', args: [ctx, initState()] }),
      stateOverride: [{ address: PHANTOM, code: S.compiled.code }],
    })
    const [order, newState] = decodeFunctionResult({ abi: S.cfg.abis.strategy, functionName: 'check', data })
    const ms = performance.now() - t0
    const verdict = order.baseAmount > 0n ? el('b', {}, `${order.isBuy ? 'BUY' : 'SELL'} ${nf0.format(Number(formatEther(order.baseAmount)))} MON`) : el('b', {}, 'idle (no order)')
    status(
      'byos-dryrun-status',
      'ok',
      `Block #${nf0.format(Number(block.number))} · oracle ${Number(formatEther(px)).toFixed(4)} → `,
      verdict,
      ` · ${ms.toFixed(0)} ms via eth_call + state override (code not deployed) · private state ${(newState.length - 2) / 2} B`,
      S.account ? '' : el('div', { class: 'muted' }, 'Connect a wallet (and fund your vault) to evaluate against your own balances.'),
    )
  } catch (e) {
    status('byos-dryrun-status', 'err', `Strategy reverted: ${e.shortMessage ?? e.message}`)
  }
}

// ───────────────────────────── vault + faucet ─────────────────────────────
async function refreshVault() {
  if (!S.account) return
  const d = S.cfg.deployment
  const [b, q] = await Promise.all(
    [d.base, d.quote].map((t) => S.pub.readContract({ address: d.pool, abi: S.cfg.abis.pool, functionName: 'balanceOf', args: [S.account, t] })),
  )
  const txt = `${nf0.format(Number(formatEther(b)))} WMON · ${nf0.format(Number(formatEther(q)))} USDC`
  $('byos-vault').textContent = txt
  $('byos-live-vault').textContent = txt
}

async function faucet() {
  $('byos-faucet').disabled = true
  status('byos-faucet-status', 'busy', 'Crediting your vault (DarkPool.depositFor, paid by the demo)…')
  try {
    const res = await fetch('/api/faucet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: S.account }) })
    const r = await res.json()
    if (!res.ok) throw new Error(r.error)
    await refreshVault()
    const mon = await S.pub.getBalance({ address: S.account })
    status(
      'byos-faucet-status',
      r.credited ? 'ok' : 'warn',
      r.credited ? `✓ Vault credited with ${nf0.format(+S.cfg.guest.faucetBase)} WMON + ${nf0.format(+S.cfg.guest.faucetQuote)} USDC. ` : `${r.note}. `,
      r.dripped ? `Sent you a little MON for gas. ` : '',
      `Wallet: ${Number(formatEther(mon)).toFixed(3)} MON.`,
    )
  } catch (e) {
    status('byos-faucet-status', 'err', `Faucet error: ${e.message}`)
  } finally {
    $('byos-faucet').disabled = false
  }
}

// ───────────────────────────── seal + register ─────────────────────────────
// Same construction as engine/src/crypto.ts: X25519 → HKDF-SHA256 → AES-256-GCM,
// layout ephemeralPub(32) | iv(12) | tag(16) | ciphertext.
async function seal(recipient, plaintext) {
  const ephPriv = x25519.utils.randomPrivateKey()
  const ephPub = x25519.getPublicKey(ephPriv)
  const shared = x25519.getSharedSecret(ephPriv, recipient)
  const key = hkdf(sha256, shared, new Uint8Array([...ephPub, ...recipient]), new TextEncoder().encode('vanta-seal-v1'), 32)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  const ctTag = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, plaintext))
  return new Uint8Array([...ephPub, ...iv, ...ctTag.slice(-16), ...ctTag.slice(0, -16)])
}

function b64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function hexBytes(hex) {
  const h = hex.slice(2)
  return new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)))
}

function stepLine(text) {
  const li = el('li', { class: 'busy' }, text)
  $('byos-seal-steps').append(li)
  return {
    ok: (...extra) => {
      li.className = 'ok'
      li.append(' ', ...extra)
    },
    err: (msg) => {
      li.className = 'err'
      li.append(' ', msg)
    },
  }
}

async function sealAndRegister() {
  const d = S.cfg.deployment
  const abis = S.cfg.abis
  $('byos-seal').disabled = true
  $('byos-seal-steps').replaceChildren()
  $('byos-seal-steps').hidden = false
  let step
  try {
    step = stepLine('Reading the attested enclave key from EnclaveRegistry (on-chain, not from our server)…')
    const signer = await S.pub.readContract({ address: d.registry, abi: abis.registry, functionName: 'latestSigner' })
    const [enc, active] = await Promise.all([
      S.pub.readContract({ address: d.registry, abi: abis.registry, functionName: 'enclaves', args: [signer] }),
      S.pub.readContract({ address: d.registry, abi: abis.registry, functionName: 'isActive', args: [signer] }),
    ])
    if (!active) throw new Error('no attested enclave is active')
    step.ok(`✓ enclave ${short(signer)} · measurement ${short(enc[0], 10, 4)}`)

    step = stepLine('Encrypting code + parameters in your browser…')
    const code = S.compiled.code
    const state = initState()
    const payload = JSON.stringify({
      firmName: ($('byos-desk').value.trim() || 'Guest desk').slice(0, 40),
      label: ($('byos-label').value.trim() || S.compiled.contract).slice(0, 120),
      contract: S.compiled.contract,
      code,
      initState: state,
    })
    const sealed = await seal(hexBytes(enc[1]), new TextEncoder().encode(payload))
    const commitment = keccak256(encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [code, state]))
    const strategyId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [S.account, commitment]))
    step.ok(`✓ ${nf0.format(sealed.length)} B ciphertext · commitment ${short(commitment, 10, 4)}`)

    const [owner, isActive] = await S.pub.readContract({ address: d.pool, abi: abis.pool, functionName: 'strategies', args: [strategyId] })
    if (owner === ZERO) {
      step = stepLine('Publishing ONLY the commitment hash: registerStrategyWithLimit (1 tx)…')
      const limit = parseEther(String(Math.max(1, Number($('byos-limit').value) || 10000)))
      const hash = await S.wallet.writeContract({
        address: d.pool,
        abi: abis.pool,
        functionName: 'registerStrategyWithLimit',
        args: [commitment, limit],
        account: S.wallet.account,
        chain: S.chain,
      })
      const r = await S.pub.waitForTransactionReceipt({ hash })
      if (r.status !== 'success') throw new Error('registration reverted')
      step.ok('✓ ', txLink(hash))
    } else if (!isActive) {
      step = stepLine('Re-activating your strategy (1 tx)…')
      const hash = await S.wallet.writeContract({ address: d.pool, abi: abis.pool, functionName: 'setStrategyActive', args: [strategyId, true], account: S.wallet.account, chain: S.chain })
      await S.pub.waitForTransactionReceipt({ hash })
      step.ok('✓ ', txLink(hash))
    }

    step = stepLine('Handing the ciphertext to the enclave (it dry-runs before accepting)…')
    let res
    for (let i = 0; i < 6; i++) {
      // the enclave reads the registration from the chain; give RPC nodes a moment to catch up
      res = await fetch('/api/strategies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ strategyId, sealed: b64(sealed) }) })
      if (res.ok || res.status !== 400) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    const body = await res.json()
    if (!res.ok) throw new Error(body.error)
    step.ok('✓ live')
    $('byos-live-budget').textContent = body.strategy?.fillsLeft == null ? '—' : `${body.strategy.fillsLeft} fills left`

    S.strategyId = strategyId
    S.active = true
    localStorage.setItem(`vanta-strategy:${d.pool}:${S.account.toLowerCase()}`, strategyId)
    await showLive(false)
  } catch (e) {
    step?.err(`✗ ${e.shortMessage ?? e.message}`)
  } finally {
    $('byos-seal').disabled = false
  }
}

// ───────────────────────────── live ─────────────────────────────
async function showLive(fromStorage) {
  const d = S.cfg.deployment
  const [owner, active] = await S.pub.readContract({ address: d.pool, abi: S.cfg.abis.pool, functionName: 'strategies', args: [S.strategyId] })
  if (owner === ZERO) return
  S.active = active
  $('byos-live').hidden = false
  $('byos-live-id').textContent = short(S.strategyId, 10, 6)
  $('byos-pause').textContent = active ? 'Pause strategy (1 tx)' : 'Resume strategy (1 tx)'
  if (fromStorage) $('byos-live-note').textContent = 'Registered earlier from this browser. If the enclave restarted, seal again to re-upload.'
  window.dispatchEvent(new CustomEvent('vanta:mine', { detail: S.strategyId }))
}

async function togglePause() {
  const d = S.cfg.deployment
  $('byos-pause').disabled = true
  try {
    const hash = await S.wallet.writeContract({ address: d.pool, abi: S.cfg.abis.pool, functionName: 'setStrategyActive', args: [S.strategyId, !S.active], account: S.wallet.account, chain: S.chain })
    await S.pub.waitForTransactionReceipt({ hash })
    S.active = !S.active
    $('byos-pause').textContent = S.active ? 'Pause strategy (1 tx)' : 'Resume strategy (1 tx)'
    $('byos-live-note').textContent = S.active ? 'Active again: the contract accepts its fills.' : 'Paused on-chain: DarkPool now rejects its fills, whatever the enclave sends.'
  } catch (e) {
    $('byos-live-note').textContent = `Error: ${e.shortMessage ?? e.message}`
  } finally {
    $('byos-pause').disabled = false
  }
}

function onEngineEvent({ type, data }) {
  if (!S.strategyId) return
  const mine = S.strategyId.toLowerCase()
  if (type === 'block') {
    const r = data.results.find((x) => x.id.toLowerCase() === mine)
    if (!r) return
    $('byos-live-last').textContent = r.error ? `⚠ ${r.error}` : r.order ? `${r.order.isBuy ? 'BUY' : 'SELL'} ${nf0.format(r.order.base)} MON @ block ${nf0.format(data.n)}` : `idle @ block ${nf0.format(data.n)}`
  } else if (type === 'strategy' && data.id.toLowerCase() === mine) {
    $('byos-live-budget').textContent = data.fillsLeft == null ? '—' : `${data.fillsLeft} fills left`
  } else if (type === 'settled') {
    const f = data.settlement.fills.find((x) => x.id.toLowerCase() === mine)
    if (!f) return
    S.myFills.unshift({ ...f, n: data.settlement.includedIn, hash: data.settlement.hash })
    const list = $('byos-live-fills')
    list.replaceChildren(
      ...S.myFills.slice(0, 8).map((x) =>
        el(
          'li',
          {},
          el('b', {}, `${x.isBuy ? 'BUY' : 'SELL'} ${nf0.format(x.base)} MON`),
          ` @ ${(x.quote / x.base).toFixed(4)} · `,
          x.crossed > 0 ? el('span', { class: 'crossed' }, `${nf0.format(x.crossed)} crossed in dark pool`) : 'routed to AMM',
          ' · ',
          txLink(x.hash),
        ),
      ),
    )
    void refreshVault()
  } else if (type === 'strategyRemoved' && data.id.toLowerCase() === mine) {
    $('byos-live-note').textContent = `Removed from the enclave (${data.reason}). Seal again to re-upload.`
  }
}

// ───────────────────────────── boot ─────────────────────────────
async function init() {
  S.cfg = await (await fetch('/api/config')).json()
  S.chain = defineChain({
    id: S.cfg.chainId,
    name: S.cfg.chainId === 10143 ? 'Monad Testnet' : S.cfg.chainId === 143 ? 'Monad' : 'Local Monad (anvil)',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [S.cfg.rpcUrl] } },
  })
  S.pub = createPublicClient({ chain: S.chain, transport: http(S.cfg.rpcUrl, { retryCount: 4 }) })

  $('byos-guest-policy').textContent = `Guest strategies: up to ${S.cfg.guest.fills} fills each, ${S.cfg.guest.ttlMin} min, ${S.cfg.guest.max} at a time.`
  $('open-byos').addEventListener('click', () => {
    $('byos').hidden = false
    if (!$('byos-code').value) void loadTemplate('range')
  })
  $('byos-close').addEventListener('click', () => ($('byos').hidden = true))
  $('byos-template').addEventListener('change', (e) => loadTemplate(e.target.value))
  $('byos-code').addEventListener('input', invalidateCompile)
  $('byos-state').addEventListener('input', invalidateCompile)
  $('byos-code').addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return
    e.preventDefault()
    const t = e.target
    const p = t.selectionStart
    t.setRangeText('    ', p, t.selectionEnd, 'end')
  })
  $('byos-connect').addEventListener('click', connectInjected)
  $('byos-burner').addEventListener('click', connectBurner)
  $('byos-compile').addEventListener('click', compile)
  $('byos-dryrun').addEventListener('click', dryRun)
  $('byos-faucet').addEventListener('click', faucet)
  $('byos-seal').addEventListener('click', sealAndRegister)
  $('byos-pause').addEventListener('click', togglePause)
  window.addEventListener('vanta:event', (e) => onEngineEvent(e.detail))
  setInterval(() => void refreshVault().catch(() => {}), 5000)
  if (new URLSearchParams(location.search).has('byos')) $('open-byos').click()
}

init().catch((e) => console.error('byos init failed', e))
