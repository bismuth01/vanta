#!/usr/bin/env bash
# Deploy Vanta contracts to Monad testnet with the master wallet in engine/.env.testnet.
#   ./scripts/deploy-testnet.sh          → simulate only: prints gas + MON estimate
#   ./scripts/deploy-testnet.sh --yes    → broadcast
# Writes deployments/10143.json (public addresses; the container ships it).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/engine/.env.testnet"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (copy engine/.env.testnet.example)"; exit 1; }
set -a; source "$ENV_FILE"; set +a
: "${MASTER_PK:?MASTER_PK not set in $ENV_FILE}"
RPC="${RPC_URL:-https://testnet-rpc.monad.xyz}"

[ -d "$ROOT/engine/node_modules" ] || (cd "$ROOT/engine" && npm install --silent)
SIM_ADDR=$(cd "$ROOT/engine" && NETWORK=testnet node src/fund.ts --address sim)
DEPLOYER=$(cast wallet address --private-key "$MASTER_PK")
echo "deployer $DEPLOYER  balance $(cast balance "$DEPLOYER" --rpc-url "$RPC" --ether) MON"
echo "oracle updater (sim) $SIM_ADDR"

# Deploy with viem: the local Foundry build ("tempo" nightly) cannot parse Monad receipts.
(cd "$ROOT/contracts" && forge build -q)
cd "$ROOT/engine"
NETWORK=testnet node src/deploy.ts "$@"
