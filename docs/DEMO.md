# Vanta: live demo script (≈ 5 minutes)

**Live app:** your Cloud Run URL (see [DEPLOY.md](../DEPLOY.md))
**Admin view:** the same URL plus `/?admin=<ADMIN_TOKEN from engine/.env.testnet>`. It shows the ⏸ Pause / ▶ Start market loop button.

The market runs in a **continuous loop** on Monad testnet, so the dashboard is always live. Each cycle is about 2.5 minutes:
calm → sell-off → capitulation bottom → breakout rally → distribution top → mean reversion → repeat.

## Before you present (2 minutes)
1. Open the app in a browser that has MetaMask (or Rabby), or plan to use the **burner wallet** (no extension needed).
2. If you use MetaMask, get a little testnet MON for the one registration tx. The burner gets gas automatically from the demo faucet.
3. Keep `contracts/src/strategies/RangeLiquidityProvider.sol` open in an editor tab as a reference. It is the default template in the app.

## Part 1: the product (≈ 1.5 min)
| Point at | Say |
|---|---|
| **Attestation strip** | "The engine is an enclave. It generated its own keys and is registered on-chain against an approved code measurement. Firms encrypt to the key *on-chain*, not to us." |
| **What MEV bots see** | "Four trading firms run strategies here. On-chain, each is just a hash. Monad has no public mempool to watch, so there's nothing to front-run." |
| **Inside the enclave** | "The same strategies, decrypted. Every one runs against live Monad state, in a single gas-capped `eth_call`, never deployed." |
| **Price chart + green bars** | "When a stop-loss and a dip-buyer fire together, we **cross them in the dark pool** at the oracle price: no slippage, no AMM fee. Only the residual (orange) touches the public AMM, with a contract-enforced price floor." |
| **KPIs** | "Crossed volume, slippage saved, batches landing about a block after evaluation." |

## Part 2: bring your own strategy (≈ 3 min)
1. Click **＋ Bring your strategy**.
2. **Connect wallet** (or **Use a burner**). The app switches you to Monad testnet.
3. **Get demo funds**. The vault is credited with 10,000 WMON + 30,000 USDC via `DarkPool.depositFor`, with no token transactions. Burners also get gas.
4. The **Range Liquidity Provider** template is pre-loaded. Read the two constants aloud:
   ```solidity
   uint256 constant BUY_BELOW  = 2.88e18;  // absorb panic selling
   uint256 constant SELL_ABOVE = 3.25e18;  // feed breakout buyers
   ```
   "If I deployed this as a normal contract, every searcher would see these levels. Here they never leave the enclave."
   *Optional live edit:* change `SELL_ABOVE` to `3.20e18` to show it really is your code.
5. **Compile in browser** (about 4 s the first time: solc runs in the page). "The source never leaves this tab."
6. **Dry-run on live Monad**. This shows the order the strategy would place at the current block against *your* vault, via `eth_call` + state override.
7. **Seal & register (1 transaction)**. Walk through the four ticks:
   - the enclave key is read from `EnclaveRegistry`;
   - the code is encrypted in the browser;
   - **only the commitment hash** goes on-chain (click the tx link to show it on MonadVision);
   - the ciphertext goes to the enclave.
8. Close the drawer. Your card appears in **Inside the enclave** tagged **YOU**. In **What MEV bots see**, it is one more opaque hash.
9. Wait for the market:
   - **Sell-off / bottom** (price < 2.88): your strategy **buys**, often crossing against Aurora's stop-loss → green bar, `B Your …` chip in the feed.
   - **Rally / top** (price > 3.25): your strategy **sells**, crossing against Cobalt's breakout buys.

   The drawer's **Your fills** list shows each fill with "crossed in dark pool" or "routed to AMM" and a tx link.
10. Optional kill switch: **Pause strategy (1 tx)**. "The firm, not the enclave operator, controls it. The contract rejects its fills."

## Closing line
"Firms get colocation-grade execution with on-chain settlement. Their alpha stays sealed, the contract bounds what the enclave can do, and MEV bots get nothing to trade against."

## If something goes wrong
- **"guest slots full"**: up to 6 guest strategies run at once (2 h each). Redeploy the service to clear them, or wait.
- **No fills for your strategy**: the market may be in a calm phase. A full cycle is about 2.5 min, and the phase pill in the header says where it is.
- **Pause the market loop** (to save MON) from the admin view, then hit ▶ to restart it. The loop auto-tops-up the relayer and sim wallets from the master wallet, 4 MON per top-up.
- **Wallet on the wrong network**: click **Connect browser wallet** again; it switches or adds Monad testnet.
