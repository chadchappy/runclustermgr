#!/usr/bin/env bash
# Deploy the Run:ai Multi-Cluster Scheduling Portal to a Kubernetes cluster.
#
#   scripts/deploy.sh environments/<name>.env      # recommended
#   scripts/deploy.sh                              # variables from the shell
#
# The env file is a plain `KEY=value` shell file (see environments/example.env).
# Nothing secret belongs in it: credentials are referenced by file path or
# environment variable. Run `scripts/deploy.sh --help` for the variable list.
set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then sed -n '2,200p' "$0" | sed -n '/^# Variables/,/^set /p' | sed '$d;s/^# \{0,1\}//'; exit 0; fi

# Variables
#   EXPECT_CONTEXT       (required) kube context you intend to deploy to; the script refuses to run elsewhere
#   IMAGE                (required) e.g. 123456789.dkr.ecr.us-east-1.amazonaws.com/runclustermgr:2.0.0
#   RUNAI_CONTROL_PLANE  (required unless MOCK=1) control plane host, no scheme
#   RUNAI_CLIENT_ID / RUNAI_CLIENT_SECRET        app credentials, or ..._FILE paths (required unless MOCK=1)
#   HOST                 ingress hostname. Default: clustermgr.<control plane host>
#   INGRESS              1 (default) or 0 for port-forward-only deployments
#   INGRESS_CLASS        default: the cluster's default IngressClass, else the only one
#   TLS_SECRET_SOURCE    namespace/name of an existing TLS secret to copy into the app namespace
#   TLS_SECRET           name for the copied TLS secret (default clustermgr-tls; used only if TLS_SECRET_SOURCE is set)
#   PULL_SECRET          existing image pull secret name in the namespace (default: none)
#   ECR_REGION           if set, create/refresh an ECR pull secret named clustermgr-regcred from the aws CLI
#   NAMESPACE            default clustermgr
#   MOCK                 1 = built-in demo data (no Run:ai calls). Default 0
#   UI_USER              default admin; the password is generated once and kept in the Secret
#   NO_FIT_STRATEGY, EXCLUDE_CLUSTERS, ALLOW_UNKNOWN_CAPACITY   placement policy, see README
#   USAGE_SOURCE         how GPU usage is measured: workloads (default, fastest) | max | telemetry
#   CAPACITY_TTL_MS      server-side capacity cache in ms (default 4000)
#   AUTO_CREATE_PROJECTS true = create a matching project on a cluster that lacks the chosen one (default false)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${1:-}" ]; then
  [ -f "$1" ] || { echo "env file not found: $1" >&2; exit 1; }
  set -a; . "$1"; set +a
fi

: "${EXPECT_CONTEXT:?set EXPECT_CONTEXT to the kube context you intend to deploy to}"
: "${IMAGE:?set IMAGE}"
NS="${NAMESPACE:-clustermgr}"
MOCK="${MOCK:-0}"
INGRESS="${INGRESS:-1}"
UI_USER="${UI_USER:-admin}"

ctx="$(kubectl config current-context)"
if [ "$ctx" != "$EXPECT_CONTEXT" ]; then
  echo "Refusing to deploy: current context is '$ctx', expected '$EXPECT_CONTEXT'" >&2
  echo "(set KUBECONFIG or switch context first)" >&2
  exit 1
fi
echo "Deploying to context: $ctx (namespace $NS)"

# ---- credentials ----
if [ "$MOCK" != "1" ]; then
  : "${RUNAI_CONTROL_PLANE:?set RUNAI_CONTROL_PLANE (or MOCK=1)}"
  [ -n "${RUNAI_CLIENT_ID_FILE:-}" ] && RUNAI_CLIENT_ID="$(tr -d '\r\n' < "${RUNAI_CLIENT_ID_FILE/#\~/$HOME}")"
  [ -n "${RUNAI_CLIENT_SECRET_FILE:-}" ] && RUNAI_CLIENT_SECRET="$(tr -d '\r\n' < "${RUNAI_CLIENT_SECRET_FILE/#\~/$HOME}")"
  : "${RUNAI_CLIENT_ID:?set RUNAI_CLIENT_ID or RUNAI_CLIENT_ID_FILE}"
  : "${RUNAI_CLIENT_SECRET:?set RUNAI_CLIENT_SECRET or RUNAI_CLIENT_SECRET_FILE}"
else
  RUNAI_CONTROL_PLANE="${RUNAI_CONTROL_PLANE:-}"; RUNAI_CLIENT_ID="${RUNAI_CLIENT_ID:-}"; RUNAI_CLIENT_SECRET="${RUNAI_CLIENT_SECRET:-}"
fi
RUNAI_CONTROL_PLANE="${RUNAI_CONTROL_PLANE#https://}"; RUNAI_CONTROL_PLANE="${RUNAI_CONTROL_PLANE%/}"

# ---- ingress defaults ----
if [ "$INGRESS" = "1" ]; then
  # Default hostname: clustermgr.<control plane host>, e.g. clustermgr.runai.example.com
  HOST="${HOST:-clustermgr.${RUNAI_CONTROL_PLANE:-}}"
  if [ -z "${INGRESS_CLASS:-}" ]; then
    INGRESS_CLASS="$(kubectl get ingressclass -o jsonpath='{range .items[?(@.metadata.annotations.ingressclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{end}' 2>/dev/null || true)"
    if [ -z "$INGRESS_CLASS" ]; then
      classes="$(kubectl get ingressclass -o name 2>/dev/null | sed 's#.*/##')"
      [ "$(printf '%s\n' "$classes" | grep -c .)" = "1" ] && INGRESS_CLASS="$classes"
    fi
  fi
  echo "Ingress: host=$HOST class=${INGRESS_CLASS:-<cluster default>}"
fi

kubectl get ns "$NS" >/dev/null 2>&1 || kubectl create ns "$NS" >/dev/null

# ---- secrets ----
if kubectl -n "$NS" get secret clustermgr-secrets >/dev/null 2>&1; then
  UI_PASSWORD="$(kubectl -n "$NS" get secret clustermgr-secrets -o jsonpath='{.data.UI_PASSWORD}' | base64 -d)"
else
  UI_PASSWORD="$(openssl rand -hex 12)"
fi
kubectl -n "$NS" create secret generic clustermgr-secrets \
  --from-literal=RUNAI_CLIENT_ID="$RUNAI_CLIENT_ID" \
  --from-literal=RUNAI_CLIENT_SECRET="$RUNAI_CLIENT_SECRET" \
  --from-literal=UI_USER="$UI_USER" \
  --from-literal=UI_PASSWORD="$UI_PASSWORD" \
  --from-literal=NO_FIT_STRATEGY="${NO_FIT_STRATEGY:-queue}" \
  --from-literal=EXCLUDE_CLUSTERS="${EXCLUDE_CLUSTERS:-}" \
  --from-literal=ALLOW_UNKNOWN_CAPACITY="${ALLOW_UNKNOWN_CAPACITY:-false}" \
  --from-literal=AUTO_CREATE_PROJECTS="${AUTO_CREATE_PROJECTS:-false}" \
  --from-literal=USAGE_SOURCE="${USAGE_SOURCE:-workloads}" \
  --from-literal=CAPACITY_TTL_MS="${CAPACITY_TTL_MS:-4000}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

TLS_NAME=""
if [ "$INGRESS" = "1" ] && [ -n "${TLS_SECRET_SOURCE:-}" ]; then
  TLS_NAME="${TLS_SECRET:-clustermgr-tls}"
  src_ns="${TLS_SECRET_SOURCE%%/*}"; src_name="${TLS_SECRET_SOURCE##*/}"
  kubectl -n "$src_ns" get secret "$src_name" -o json \
    | node -e 'const s=JSON.parse(require("fs").readFileSync(0));console.log(JSON.stringify({apiVersion:"v1",kind:"Secret",type:s.type,metadata:{name:process.argv[1],namespace:process.argv[2]},data:s.data}))' "$TLS_NAME" "$NS" \
    | kubectl apply -f - >/dev/null
  echo "Copied TLS secret $TLS_SECRET_SOURCE -> $NS/$TLS_NAME"
fi

PULL_NAME="${PULL_SECRET:-}"
if [ -n "${ECR_REGION:-}" ]; then
  PULL_NAME="clustermgr-regcred"
  registry="${IMAGE%%/*}"
  kubectl -n "$NS" create secret docker-registry "$PULL_NAME" --docker-server="$registry" --docker-username=AWS \
    --docker-password="$(aws ecr get-login-password --region "$ECR_REGION")" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  echo "Refreshed ECR pull secret for $registry (valid ~12h)"
fi

# ---- apply ----
IMAGE="$IMAGE" RUNAI_CONTROL_PLANE="$RUNAI_CONTROL_PLANE" MOCK="$MOCK" INGRESS="$INGRESS" \
HOST="${HOST:-}" INGRESS_CLASS="${INGRESS_CLASS:-}" TLS_SECRET="$TLS_NAME" PULL_SECRET="$PULL_NAME" \
  node "$HERE/render-manifest.js" | kubectl apply -f - >/dev/null

# The Secret can change without the pod spec changing; restart so new values are read.
kubectl -n "$NS" rollout restart deploy/clustermgr >/dev/null
kubectl -n "$NS" rollout status deploy/clustermgr --timeout=180s

echo
[ "$MOCK" = "1" ] && echo "NOTE: MOCK=1, the UI shows built-in demo data, not your clusters."
[ "$INGRESS" = "1" ] && echo "URL:       $([ -n "$TLS_NAME" ] && echo https || echo http)://$HOST"
echo "User:      $UI_USER"
echo "Password:  kubectl -n $NS get secret clustermgr-secrets -o jsonpath='{.data.UI_PASSWORD}' | base64 -d"
echo "Port-forward: kubectl -n $NS port-forward svc/clustermgr 3000:80   ->  http://localhost:3000"
