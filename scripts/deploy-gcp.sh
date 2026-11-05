#!/usr/bin/env bash
# Deploy the engine + dashboard to Cloud Run as a single always-on instance.
#   GCP_PROJECT=<id> [GCP_REGION=us-central1] ./scripts/deploy-gcp.sh
# Secrets (MASTER_PK, ADMIN_TOKEN) go into Secret Manager straight from engine/.env.testnet;
# they are never printed, baked into the image, or passed on the command line.
set -euo pipefail
export PATH="$HOME/google-cloud-sdk/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${GCP_PROJECT:?set GCP_PROJECT}"
REGION="${GCP_REGION:-us-central1}"
SERVICE="${SERVICE:-vanta}"
ENV_FILE="$ROOT/engine/.env.testnet"
[ -f "$ROOT/deployments/10143.json" ] || { echo "deploy contracts first: ./scripts/deploy-testnet.sh --yes"; exit 1; }
POOL=$(python3 -c "import json;print(json.load(open('$ROOT/deployments/10143.json'))['pool'])")
[ "$(cast codesize "$POOL" --rpc-url https://testnet-rpc.monad.xyz)" != "0" ] || { echo "DarkPool $POOL has no code on testnet"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 1; }

read_env() { (set -a; source "$ENV_FILE"; printf '%s' "${!1:-}"); }
put_secret() { # name, value-on-stdin
  if gcloud secrets describe "$1" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud secrets versions add "$1" --data-file=- --project "$PROJECT" >/dev/null
  else
    gcloud secrets create "$1" --data-file=- --replication-policy=automatic --project "$PROJECT" >/dev/null
  fi
}

echo "▶ enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com --project "$PROJECT"

echo "▶ storing secrets"
[ -n "$(read_env MASTER_PK)" ] || { echo "MASTER_PK missing in $ENV_FILE"; exit 1; }
read_env MASTER_PK | put_secret vanta-master-pk
ADMIN_TOKEN="$(read_env ADMIN_TOKEN)"
if [ -z "$ADMIN_TOKEN" ]; then
  ADMIN_TOKEN="$(openssl rand -hex 16)"
  printf '\nADMIN_TOKEN=%s\n' "$ADMIN_TOKEN" >> "$ENV_FILE"
fi
printf '%s' "$ADMIN_TOKEN" | put_secret vanta-admin-token

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for s in vanta-master-pk vanta-admin-token; do
  gcloud secrets add-iam-policy-binding "$s" --project "$PROJECT" \
    --member "serviceAccount:$RUNTIME_SA" --role roles/secretmanager.secretAccessor >/dev/null
done

ENV_VARS="NETWORK=testnet"
for k in RPC_URL WS_URL; do v="$(read_env $k)"; [ -n "$v" ] && ENV_VARS="$ENV_VARS,$k=$v"; done

echo "▶ building contracts"
(cd "$ROOT/contracts" && forge build -q)

echo "▶ deploying Cloud Run service $SERVICE ($REGION)"
# One instance only: the enclave, its keys and the block loop are a singleton.
gcloud run deploy "$SERVICE" --source "$ROOT" --project "$PROJECT" --region "$REGION" \
  --allow-unauthenticated --port 8080 --cpu 1 --memory 512Mi \
  --min-instances 1 --max-instances 1 --no-cpu-throttling --timeout 3600 --session-affinity \
  --set-env-vars "$ENV_VARS" \
  --set-secrets "MASTER_PK=vanta-master-pk:latest,ADMIN_TOKEN=vanta-admin-token:latest"

# Old revisions keep their always-on CPU and background loops alive (a second engine, sim and
# firm wallets in use). Only one enclave may run: delete every revision that is not serving.
for r in $(gcloud run revisions list --service "$SERVICE" --project "$PROJECT" --region "$REGION" \
    --filter="status.conditions.status!=True OR NOT status.conditions.type=Active" --format="value(name)"); do
  [ "$r" = "$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.latestReadyRevisionName)')" ] && continue
  gcloud run revisions delete "$r" --project "$PROJECT" --region "$REGION" --quiet >/dev/null && echo "  deleted old revision $r"
done

URL=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')
echo
echo "public dashboard : $URL"
echo "admin (run demo) : $URL/?admin=<ADMIN_TOKEN from engine/.env.testnet>"
