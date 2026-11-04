#!/usr/bin/env bash
# One-command local demo: anvil (300ms blocks, like Monad) → deploy → enclave engine
# → onboard 4 firms with sealed strategies → scripted market → dashboard.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/.logs"; mkdir -p "$LOGS"
DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
SIM_ADDR=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
PIDS=()
cleanup() { echo; echo "stopping…"; for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

wait_for() { for _ in $(seq 1 100); do eval "$1" >/dev/null 2>&1 && return 0; sleep 0.2; done; echo "timeout: $1"; exit 1; }

[ -d "$ROOT/engine/node_modules" ] || (cd "$ROOT/engine" && npm install --silent)

echo "⛓  starting local chain (anvil, 300 ms blocks)"
anvil --block-time 0.3 --port 8545 --silent > "$LOGS/anvil.log" 2>&1 & PIDS+=($!)
wait_for "cast block-number --rpc-url http://127.0.0.1:8545"

echo "📜 deploying contracts"
(cd "$ROOT/contracts" && forge build -q && WRITE_DEPLOYMENT=true ORACLE_UPDATER=$SIM_ADDR forge script script/Deploy.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast --private-key $DEPLOYER_PK > "$LOGS/deploy.log" 2>&1)

echo "🛡  booting enclave engine"
(cd "$ROOT/engine" && exec node src/engine.ts) > "$LOGS/engine.log" 2>&1 & PIDS+=($!)
wait_for "curl -sf http://127.0.0.1:8787/api/enclave"
sed -n '1,5p' "$LOGS/engine.log"

echo "🏦 onboarding firms (sealing strategies to the attested key)"
(cd "$ROOT/engine" && node src/firms.ts)

echo "📈 starting market simulator"
(cd "$ROOT/engine" && exec node src/sim.ts) > "$LOGS/sim.log" 2>&1 & PIDS+=($!)

echo
echo "📊 dashboard → http://127.0.0.1:8787   (Ctrl-C to stop; logs in .logs/)"
tail -n +6 -f "$LOGS/engine.log"
