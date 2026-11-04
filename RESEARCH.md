# On-chain Secure Execution / Dark Pool on Monad — Research & Architecture

_Research date: 2026-11-04. Items marked **(unverified)** could not be confirmed from primary sources._

## 1. The core problem: the colocation analogy breaks in one key place

In TradFi HFT, a firm's FPGA is **private** (no one can read the strategy) and the exchange gives **fair, deterministic ordering** (price-time FIFO). On a public chain, neither holds by default:

| TradFi colocation | Naive Web3 version | Consequence |
|---|---|---|
| Strategy lives on your FPGA | Strategy is a public Solidity contract | Anyone can read the bytecode, simulate the trigger, and front-run it |
| Exchange matching engine orders fairly | Block leader orders txs (priority-gas auction by default) | Leader / sidecars can reorder around your trade |
| Market data via cross-connect | RPC / websocket | Latency + speculative state |
| Exchange runs the matching engine | Nobody runs code "every block" for free | Someone must pay gas to evaluate conditions |

**Conclusion:** a "Solidity contract that is evaluated after every block" is the right *developer interface*, but those contracts **must not be deployed publicly or evaluated on-chain**. They should be evaluated privately, off-chain, against the latest state. Only the resulting **settlement** should go on-chain, with on-chain guards that make the settlement safe even if the off-chain part misbehaves.

## 2. Relevant Monad facts (Nov 2026)

**Execution & consensus**
- **Blocks:** ~300 ms since MIP-12 (Jul 2026); measured ~0.304 s on mainnet.
- **Finality:** speculative after 1 slot, full after 2 slots (~600 ms).
- **Async execution:** consensus orders txs before executing them, and the state root lags by D=3 blocks. On-chain code always sees current state at execution, but off-chain actors work on slightly stale or speculative state. Design rule: **always re-check conditions on-chain at execution.**
- **Block states:** Proposed → Voted → Finalized → Verified. RPC `latest` = Proposed (speculative), `safe` = Voted, `finalized` = Finalized.
- **No native per-block hook, cron, or system callback.**
  - Monad-specific precompiles are only P256 (`0x0100`), staking (`0x1000`) and reserve balance (`0x1001`).
  - EIP-7702, transient storage and EIP-2935 are supported. Contract size limit is 128 KB.

**Mempool**
- There is no global public mempool. RPC nodes forward a tx to the next 3 leaders and retry up to 3 times.
- The leader schedule is public per epoch.
- `newPendingTransactions` is not supported.
- Ordering inside a block is at the leader's discretion.
- One academic study (Sept 2026) found **no persistent sandwich attackers** on Monad so far. The residual MEV risk is leaders and their sidecars.

**Gas & accounts — gotchas for an executor**
- **Gas is charged on the gas *limit*, not gas used.** Failed or over-padded triggers burn money. Set tight limits from simulation.
- **Reserve balance:** each EOA's in-flight gas spend is capped at roughly min(10 MON, its lagged balance). To send many txs per block, shard across multiple executor keys.
- **Nonces:** `eth_getTransactionCount` ignores pending txs, so track nonces locally.
- **Timestamps:** `block.timestamp` has 1 s granularity, so 3–4 blocks share it. Use `block.number` for guards.

**Low-latency data — the "colocation" equivalent**
- The **Execution Events SDK** (C/C++/Rust) is a shared-memory ring with microsecond latency: logs, call frames, state reads/writes. It must run on the same host as the node.
- Websocket `monadNewHeads` / `monadLogs` include commit-state updates.
- Full-node hardware: 16 cores at ≥4.5 GHz, 32 GB+ RAM, 2 TB NVMe plus 500 GB, **bare metal**.

**MEV infrastructure**
- **FastLane MEV Protocol:** a validator sidecar used by ~111 of 194 validators.
  - The Auction Handler (`0xD32EdF66…FFF58`) supports top-of-block and back-run bids.
  - A Leader API shows which upcoming leaders run FastLane.
- **Atlas** (app-specific sequencing / OFA) exists for Monad. Chainlink acquired it in Jan 2026 for SVR.
- **bloXroute Monad Fast RPC** (unverified privacy claims).

**Keepers**
- Gelato Web3 Functions ended 2026-03-31.
- Chainlink Automation is deprecated and was never on Monad. Its replacement, CRE, has no per-block trigger.
- FastLane Task Manager is experimental/testnet (unverified on mainnet).
- **Plan to run your own executor.**

**Oracles**
- Pyth Pro (ex-Lazer) is on mainnet with 1–50 ms channels.
- Chainlink Price Feeds/Data Streams, RedStone (Bolt), Stork, Chronicle and Supra are also available.

**Liquidity to route to**
- **Spot:** Kuru (hybrid CLOB/AMM, ~47% of DEX volume), Uniswap v4 (PoolManager `0x188d586d…9ea8e`), Curve, Hanji.
- **Order protocols:** 1inch Fusion / Limit Order Protocol.
- **Perps:** Perpl.
- **Lending:** Aave v3, Morpho, Euler.

**Privacy on Monad**
- **Railgun is NOT on Monad.** It is on Ethereum, Arbitrum, Polygon and BNB; Base is reportedly live (unverified).
- **Unlink** is live since 2026-06-25: Groth16 private balances, including private `execute` against external contracts. It is the Monad-native Railgun equivalent.
- **TACEO Merces:** MPC + collaborative-ZK private USDC (limited access).
- **Monad Private Settlement** (Category Labs, published 2026-10-06): encrypted execution domains with atomic settlement against L1 liquidity. This is exactly this use case, but it is **design-only and its cryptography is undisclosed**.
- **BTX:** batched threshold encryption research toward an encrypted mempool. No MIP, no date.
- **FHE (Zama, Fhenix, Inco):** not on Monad.

## 3. What each privacy/MEV technique actually solves

Four separate properties are needed: **(a)** hide identity, **(b)** hide strategy until execution, **(c)** fair ordering at execution, **(d)** atomic execution.

| Technique | (a) | (b) | (c) | (d) | Trust | Fit for Monad today |
|---|---|---|---|---|---|---|
| Railgun / Unlink (shielded pool + adapt contract) | ✅ | ❌ calldata public at execution | ❌ | ✅ | zk trusted setup | Unlink ✅, Railgun ❌ |
| Public Solidity strategy + keeper | ❌ | ❌ | ❌ | ✅ | keeper | ✅ but leaks everything |
| TEE strategy engine (Intel TDX via Phala dstack / Oasis ROFL) | partial | ✅ | ❌ (needs on-chain guards) | ✅ | hardware vendor + physical security | ✅ chain-agnostic |
| MPC dark pool (Renegade) | partial | partial (relayers see orders) | ✅ (midpoint) | ✅ | relayers | ❌ Arbitrum/Base only |
| FHE coprocessor (Zama/Fhenix) | ❌ | ✅ | ✅ for encrypted values | ❌ async decrypt | threshold KMS | ❌ not on Monad, ~20 TPS |
| Threshold-encrypted mempool (Shutter/BTX) | ❌ | ✅ until ordered | ✅ | ✅ | key-holder threshold | ❌ research only |
| Batch auctions (CoW, Penumbra) | ❌ | ❌ | ✅ | ✅ | solvers | ❌ CoW not on Monad |
| Monad Private Settlement | ✅ | ✅ | inherits L1 | ✅ DvP | undisclosed | ❌ design only |

**Railgun on its own does not stop MEV.** It hides *who* trades, but the swap is public and sandwichable when it runs. MEV protection has to come from (b) and (c).

## 4. Proposed architecture: "Sealed Strategy Engine" + on-chain Settlement Vault

```
                 ┌──────────────── Bare-metal host (TDX-capable) ─────────────────┐
 Firm uploads    │  ┌───────────────┐ shared mem  ┌──────────────────────────────┐ │
 encrypted  ─────┼─▶│ Monad full    │────────────▶│ TEE enclave (Intel TDX)      │ │
 Solidity        │  │ node          │ Exec Events │  • decrypts strategy bytecode│ │
 bytecode        │  │               │ (µs)        │  • revm: runs every strategy │ │
 (to enclave key)│  └───────────────┘             │    IStrategy.check() per blk │ │
                 │                                │  • internal crossing engine  │ │
                 │                                │  • signs settlement batches  │ │
                 │                                └──────────────┬───────────────┘ │
                 └───────────────────────────────────────────────┼─────────────────┘
                                                                 │ signed tx → next 3 leaders
                                                                 ▼ (direct / FastLane-aware)
 ┌───────────────────────────────── Monad L1 ──────────────────────────────────────┐
 │ EnclaveRegistry   – verifies TDX DCAP quote on-chain (Automata verifier),        │
 │                     registers enclave signing key + code measurement            │
 │ DarkPoolVault     – firm sub-accounts (optionally funded via Unlink)            │
 │ Settlement        – executeBatch(sig, fills[], routes[]):                       │
 │                       • only registered enclave key                             │
 │                       • per-firm risk limits (max notional/block, allowlists)   │
 │                       • oracle band check (Pyth Pro, staleness)                 │
 │                       • minOut / validUntilBlock / nonce                        │
 │                       • internal crosses = vault ledger transfers (no AMM)      │
 │                       • residual → Kuru / Uniswap v4 / 1inch, atomic or revert  │
 └─────────────────────────────────────────────────────────────────────────────────┘
```

### Why this shape
1. **Firms still write Solidity.** A strategy implements an interface such as:
   ```solidity
   interface IStrategy {
       // Evaluated off-chain inside the enclave every block, against latest state.
       function check(BlockContext calldata ctx) external view
           returns (Order[] memory orders);
   }
   ```
   The bytecode is **never deployed on-chain**. It is encrypted to the enclave's attested key, and the enclave runs it in `revm` against live state read from the local node. That gives the "contract that runs after every block" experience without publishing the strategy.
2. **Evaluation is free per block.** Off-chain EVM execution costs nothing on-chain, so hundreds of strategies can run inside the 300 ms budget. Gas is only paid when something triggers, which matters because Monad charges the full gas limit.
3. **The "dark pool" part is internal crossing.**
   - When triggered orders on opposite sides exist in the same block, the enclave matches them at the oracle midpoint (Pyth Pro) and settles as **vault ledger transfers**.
   - They never touch an AMM, so there is no price impact or public swap to sandwich.
   - Only the residual is routed to public venues.
   - This is Renegade's model, with TEE instead of MPC and with conditional logic.
4. **MEV protection at execution** for whatever goes to public venues:
   - tight `minOut` derived from oracle price;
   - `validUntilBlock` set to N+2;
   - no public mempool, so the tx only goes to the next 3 leaders;
   - optionally prefer leaders not running FastLane via the Leader API, or route via Atlas once usable;
   - optionally capture your own back-run via the FastLane Auction Handler.
5. **Defense in depth.** The Settlement contract enforces risk limits per firm. Even a compromised enclave or operator cannot move funds beyond pre-set limits or outside oracle bands. TEEs are breakable with physical access (TEE.fail, 2025–26), so this matters.
6. **Identity privacy (a)** is optional: fund vault sub-accounts through **Unlink**, the Monad-native shielded pool. Railgun would only become relevant if you go multichain.

### Latency budget (target)
| Step | Expected |
|---|---|
| Block proposed → Execution Events in enclave | µs–ms |
| Run all strategies (revm) + crossing | 1–50 ms (depends on count/complexity) |
| Sign + send to next leaders | ~ms (co-located node) |
| Inclusion | typically block N+1/N+2 (~300–600 ms) |
| Full finality | +600 ms |

**Speculative-state caveat:** triggering on *Proposed* blocks is fastest, but those blocks can be abandoned. The on-chain re-check, `validUntilBlock` and oracle bands make a stale trigger revert rather than mis-fill. Reverts still cost the full gas limit, so tune aggressiveness.

### Known weaknesses / honest trade-offs
- **The TEE is the trust anchor for strategy confidentiality.** A host with physical access could extract strategies. Mitigations:
  - reputable or independent operators;
  - remote attestation published on-chain;
  - let firms run their *own* enclave host, the true colocation analogue.
- **The data feed is host-controlled.** The host could delay or withhold blocks from the enclave. The enclave should verify block headers and QCs and refuse stale data.
- **Execution is still visible on-chain.** Internal crosses reveal vault ledger movements (use Unlink to unlink identities). Residual swaps are public at execution, which is unavoidable until Monad ships encrypted mempool or Private Settlement.
- **Liveness:** a single operator can censor. Long term, run multiple enclaves with deterministic batch output, or let firms self-host.
- **Regulatory/compliance:** dark pools and private balances attract scrutiny. Railgun uses Proofs of Innocence and Unlink has its own compliance layer. Decide early on KYC for participating firms.

### Simpler alternatives considered
- **Public Uniswap v4 hook** that fills resting conditional orders in `afterSwap`:
  - no keeper, and the swapper pays gas;
  - but the strategy is fully public and it only works on hooked pools;
  - good for stop-loss/limit products, not for alpha.
- **1inch Limit Order Protocol predicates** (live on Monad): on-chain conditional fills by any filler. Again public.
- **Wait for Monad Private Settlement:** the ideal native fit, but no date. Design the vault/settlement interfaces so the enclave backend can later be swapped for an encrypted execution domain.

## 5. Phased roadmap

| Phase | Deliverable | Privacy level |
|---|---|---|
| **0 – Prototype (testnet)** | Foundry: `DarkPoolVault`, `Settlement` (risk limits, oracle band, minOut, validUntilBlock), `IStrategy` interface. Rust executor: Monad node + Execution Events → revm strategy runner → batch signer. Plain (non-TEE). | none (operator sees strategies) |
| **1 – Sealed strategies** | Executor in Intel TDX (Phala dstack); on-chain DCAP attestation via Automata; strategy upload encrypted to the enclave key; key-rotation / measurement registry. | (b) strategy hidden |
| **2 – Dark pool crossing** | Internal matching at Pyth Pro mid with per-block batch clearing; residual routing to Kuru / Uniswap v4 / 1inch; FastLane-aware submission. | (b) + (c) for crossed flow |
| **3 – Identity & decentralization** | Unlink-funded sub-accounts; multi-operator enclaves; firm self-hosted enclaves; migrate to Monad Private Settlement / BTX when live. | (a)+(b)+(c)+(d) |

## 6. Open questions to decide
1. **Who operates?** A multi-tenant venue (you run the enclaves) or software that each firm self-hosts. Self-hosting is closer to colocation and avoids cross-firm trust, but loses internal crossing between firms.
2. **Is a TEE trust model acceptable to the target firms?** If not, the only alternatives are MPC (Renegade-style, much harder) or waiting for Monad Private Settlement.
3. **Asset scope:** spot only (Kuru / Uniswap v4), or also perps (Perpl) and lending?
4. **Compliance posture:** KYC'd firms only?

## Key sources
- Monad docs: async execution, block states, local mempool, reserve balance, gas pricing, precompiles, execution events, hardware — https://docs.monad.xyz
- MIP-12 (300 ms blocks) — https://mips.monad.xyz/MIPs/MIP-12
- Monad Private Settlement — https://monad.xyz/blog/monad-private-settlement , https://github.com/category-labs/monad-domains
- BTX encrypted mempool research — https://monad.xyz/blog/btx-batch-threshold-encryption
- Unlink on Monad — https://monad.xyz/blog/privacy-comes-to-monad-with-unlink
- FastLane MEV / Auction Handler / Leader API — https://www.fastlane.xyz/blog/fastlane-mev-protocol , https://docs.shmonad.xyz/searchers/mev-auction-handler
- Atlas on Monad — https://github.com/FastLane-Labs/atlas-on-monad
- Monad sandwich study — https://arxiv.org/html/2609.28115v1
- Railgun cross-contract calls — https://docs.railgun.org/developer-guide/wallet/transactions/cross-contract-calls
- Renegade — https://whitepaper.renegade.fi/ ; critique https://arxiv.org/abs/2609.27100v1
- Zama protocol — https://docs.zama.org/protocol/zama-protocol-litepaper
- Phala dstack — https://github.com/Dstack-TEE/dstack ; Automata DCAP — https://github.com/automata-network/awesome-automata
- TEE.fail — https://tee.fail/
- Pyth Pro addresses — https://docs.pyth.network/price-feeds/pro/contract-addresses
- Uniswap v4 deployments — https://developers.uniswap.org/docs/protocols/v4/deployments
- 1inch Limit Order Protocol — https://github.com/1inch/limit-order-protocol
