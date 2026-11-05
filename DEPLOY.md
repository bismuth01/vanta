# Deploying Vanta

This guide takes you from a fresh clone to your own running copy. There are three stages, and you can stop after any of them:

1. **Local demo**: anvil chain, no wallet or cloud needed (≈ 5 min)
2. **Monad testnet**: your own contracts, funded with your own testnet wallet (≈ 10 min)
3. **Google Cloud Run**: a public URL for the dashboard and the bring-your-own-strategy flow (≈ 15 min)

> Never paste private keys into chats, issues or commits. Keys live only in `engine/.env.testnet` (gitignored) and, when hosted, in Google Secret Manager.

---

## 0. Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Node.js | **≥ 22.18** (24 recommended) | engine, scripts. Runs `.ts` files directly, no build step |
| Foundry (`forge`, `cast`, `anvil`) | recent stable | compiling/testing contracts, local chain |
| Google Cloud CLI (`gcloud`) | any recent | stage 3 only |
| `openssl`, `python3`, `curl` | system | used by the deploy scripts |

```bash
git clone https://github.com/bismuth01/vanta.git && cd vanta
(cd engine && npm install)
(cd contracts && forge build && forge test)   # forge-std is vendored in contracts/lib
```

All contract tests should pass.

---

## 1. Local demo

```bash
./scripts/demo.sh
# → http://127.0.0.1:8787
```

The script:
1. starts `anvil` with 300 ms blocks;
2. deploys the contracts with anvil's dev keys;
3. boots the enclave engine;
4. onboards the four demo firms;
5. runs the scripted market in a loop.

Logs go to `.logs/`. Press Ctrl-C to stop everything.

To try **＋ Bring your strategy** locally, choose **Use a burner** in the drawer. The local faucet funds it.

---

## 2. Monad testnet

### 2.1 Wallet and secrets
You need **one** Monad-testnet wallet with MON (see the costs section for how much). Every other role (relayer, market sim, four demo firms) gets a key **derived** from it, so you never manage more than one key.

```bash
cp engine/.env.testnet.example engine/.env.testnet
# edit engine/.env.testnet and set:
#   MASTER_PK=<your private key>   (with or without 0x)
# optional:
#   RPC_URL=<dedicated Monad testnet RPC>   (the public RPC rate-limits under load)
#   WS_URL=<matching websocket URL>
```

### 2.2 Deploy the contracts
```bash
./scripts/deploy-testnet.sh          # dry run: prints deployer, balance, plan
./scripts/deploy-testnet.sh --yes    # deploys tokens, oracle, AMM, registry, DarkPool
```

This writes `deployments/10143.json`.
- **You must deploy your own contracts.** The file committed in this repo points at the original hackathon deployment, whose `EnclaveRegistry` is owned by a different wallet. The engine needs the registry owner key to approve its enclave build, so reusing that file with your key fails.
- The deploy runs through `engine/src/deploy.ts` (viem), not `forge script`. Some Foundry nightly builds cannot parse Monad receipts (`missing field feePayer` / `timestampMillis`).
- To redeploy **only** `DarkPool` and reuse the tokens, oracle, AMM and registry:
  ```bash
  cd engine && NETWORK=testnet node src/deploy.ts --yes --pool-only
  ```

### 2.3 Fund the role wallets
```bash
cd engine
NETWORK=testnet node src/fund.ts                                        # prints the plan only
NETWORK=testnet FUND_RELAYER=4 FUND_SIM=4 FUND_FIRM=0.5 node src/fund.ts --yes
NETWORK=testnet node src/fund.ts --address relayer                      # print one role's address
```

### 2.4 (Optional) Run the engine against testnet from your machine
```bash
cd engine
NETWORK=testnet ADMIN_TOKEN=pick-something node src/engine.ts
# → http://127.0.0.1:8787   (open /?admin=pick-something for the market loop button)
```

Run **only one engine at a time** per deployment. Each boot registers a fresh enclave key and revokes the previous one, so a second engine's batches fail with `unattested signer`. Stop any local engine before deploying to Cloud Run.

---

## 3. Google Cloud Run

### 3.1 One-time project setup
```bash
gcloud auth login
gcloud config set project <PROJECT_ID>      # billing must be enabled
```

New projects need the default compute service account to have the Cloud Run builder role, or the source build fails with `PERMISSION_DENIED`:
```bash
PROJECT_NUMBER=$(gcloud projects describe <PROJECT_ID> --format='value(projectNumber)')
gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role roles/run.builder --condition=None
```

### 3.2 Deploy
```bash
GCP_PROJECT=<PROJECT_ID> [GCP_REGION=us-central1] ./scripts/deploy-gcp.sh
```

The script:
1. **Enables APIs:** Run, Cloud Build, Artifact Registry and Secret Manager.
2. **Stores secrets.** It puts `MASTER_PK` into the Secret Manager secret `vanta-master-pk`. It generates an `ADMIN_TOKEN` (appended to `engine/.env.testnet`) and stores it as `vanta-admin-token`. Secrets are never baked into the image.
3. **Builds** the contracts locally, then builds the image with Cloud Build from the `Dockerfile`.
4. **Deploys** service `vanta`: exactly **one** instance, always-on CPU, 60-min request timeout for websockets.
5. **Deletes every non-serving revision.** Old revisions keep their always-on CPU, which would leave a second engine and market sim running and spending MON.

It prints:
- **Public dashboard:** `https://vanta-<hash>.<region>.run.app`
- **Admin:** `<url>/?admin=<ADMIN_TOKEN>`. Open it once per tab. It adds the **⏸ Pause / ▶ Start market loop** button, and the token is then removed from the address bar.

If your org policy blocks `--allow-unauthenticated`, ask for an exception or remove that flag and use IAP or authenticated access.

### 3.3 After deploying
- **Boot sequence:** the engine attests on-chain, re-onboards the demo firms, and starts the **market loop** automatically. Each cycle takes about 7 minutes: calm → sell-off → bottom → rally → top → reversion.
- **Health:** `curl <url>/health` and `curl <url>/api/scenario`.
- **Logs:** `gcloud run services logs read vanta --region <region> --limit 100`

---

## 4. Costs and operating

**Testnet MON.** The always-on market sends real transactions: oracle updates, AMM arbitrage and settlement batches. A settlement batch costs about **0.045 MON** on testnet, because Monad bills the gas *limit*. The original deployment burned **tens of MON per hour**, and about 100 MON over one unattended night. So:
- **Pause the loop** from the admin view whenever you aren't demoing.
- The loop tops up the relayer, sim and firm wallets from the master wallet before each cycle.
- It **pauses itself** when the master wallet drops below `TOPUP_MASTER_FLOOR` (default 3 MON), or after 3 failed cycles in a row. The reason shows in the red header pill.

**GCP.** One always-on 1 vCPU / 512 MiB instance costs roughly $1.5–2 per day.

### Tuning (environment variables)
Set them in `engine/.env.testnet` for local runs. For Cloud Run, use `gcloud run services update vanta --region <region> --update-env-vars KEY=VALUE,...`. Note that `deploy-gcp.sh` passes only `NETWORK`, `RPC_URL` and `WS_URL`, so re-apply your overrides after each redeploy, or add them to `ENV_VARS` in the script.

| Variable | Hosted default | Meaning |
|---|---|---|
| `MARKET_LOOP` | `1` | start the scripted market on boot |
| `SIM_STEP_MS` | `2500` | oracle tick interval (each tick = 1–2 txs) |
| `SIM_ARB_BPS` | `25` | re-align the AMM to the oracle only above this gap |
| `BATCH_EVERY_BLOCKS` | `8` | settlement window (fewer txs, more crossing) |
| `VALID_FOR_BLOCKS` | `12` | batch expiry window |
| `TOPUP_BELOW` / `TOPUP_AMOUNT` | `1` / `2` | relayer and sim auto top-up (MON) |
| `TOPUP_FIRM_BELOW` / `TOPUP_FIRM_AMOUNT` | `0.1` / `0.3` | firm wallet auto top-up (MON) |
| `TOPUP_MASTER_FLOOR` | `3` | loop pauses itself below this master balance |
| `GUEST_MAX` / `GUEST_FILLS` / `GUEST_TTL_MIN` | `6` / `300` / `120` | bring-your-own-strategy limits |
| `FAUCET_BASE` / `FAUCET_QUOTE` / `FAUCET_MAX` | `10000` / `30000` / `40` | guest vault credit (mock WMON/USDC) and total credits |
| `DRIP_MON` / `DRIP_MAX` | `0.15` / `25` | gas for burner wallets |
| `RPC_URL` / `WS_URL` / `PUBLIC_RPC_URL` | Monad public RPC | engine RPC / block subscription / RPC exposed to browsers |
| `EVAL_MODE` | `multicall` | `multicall` = one gas-capped `eth_call` per block; `parallel` = one per strategy |

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Batches fail with `unattested signer` | Two engines running (a local one, or an old Cloud Run revision) | Stop the other engine; `gcloud run revisions list --service vanta` and delete non-serving revisions |
| Header shows `⚠ market: … firms: insufficient funds` | Firm wallets out of gas | `NETWORK=testnet FUND_FIRM=0.5 node src/fund.ts --yes`, then ▶ Start market loop |
| Header shows `master wallet low` | Master below the floor | Send MON to the master wallet, then ▶ Start |
| `HTTP request failed` / 429 in logs | Public RPC rate limits | Set a dedicated `RPC_URL`/`WS_URL` and redeploy |
| `batch expired` | Inclusion slower than the window | Raise `VALID_FOR_BLOCKS` |
| `slippage` reverts | The AMM drifted > 1.5 % from the oracle under one-sided flow | Expected guard; deepen the AMM liquidity or lower slice sizes |
| Cloud Build `PERMISSION_DENIED` | Missing builder role | §3.1 IAM command |
| `forge script` fails with `missing field feePayer` | Foundry nightly vs Monad receipts | Use `./scripts/deploy-testnet.sh` (viem-based) |

---

## 6. Tear down
```bash
# 1. stop spending: pause the loop from the admin view, then
gcloud run services delete vanta --region <region> --quiet
# 2. optional cleanup
gcloud secrets delete vanta-master-pk --quiet
gcloud secrets delete vanta-admin-token --quiet
gcloud artifacts repositories delete cloud-run-source-deploy --location <region> --quiet
```

MON left in the derived role wallets stays there. Their keys are derived from `MASTER_PK` as `keccak256(MASTER_PK ‖ "vanta:<role>")`, and `NETWORK=testnet node src/fund.ts` lists their addresses and balances.
