# Deployment guide

> New here? Start with the [customer guide](customer-guide.md), a step-by-step install. This page is the reference for every option.

## 1. Prerequisites

- A Run:ai control plane (3.0+) with the clusters you want to schedule across registered in it.
- A Run:ai **application** (Settings → Access → Applications) for the manager. It needs to read clusters, projects, nodes/telemetry and workloads, and create workloads (workspace, training, distributed, inference) in the projects you will use.
- `kubectl` access to the cluster that will host the manager (any cluster that can reach the control plane over HTTPS; it does not have to be one of the Run:ai clusters).
- An image registry the cluster can pull from.

## 2. Build and publish the image

```bash
docker buildx build --platform linux/amd64 -t <registry>/runclustermgr:2.2.3 --push .
```

Use `linux/amd64,linux/arm64` for mixed fleets. Tags should be immutable: bump the version for every release rather than reusing `latest`. Pushing a `v*` git tag runs the same build in CI and publishes to `ghcr.io/<owner>/<repo>`.

Registry examples:

| Registry | Setup |
|---|---|
| GHCR (public package) | nothing; set `IMAGE=ghcr.io/<owner>/<repo>:v2.1.1` |
| GHCR (private) | create a pull secret in the namespace, set `PULL_SECRET=<name>` |
| ECR | `ECR_REGION=us-east-1` in the env file; the script creates and refreshes `clustermgr-regcred` on every deploy. ECR tokens last ~12h, so redeploy (or refresh the secret) before a pod has to pull on a node that lacks the image |

## 3. Describe the environment

```bash
cp environments/example.env environments/<name>.env
```

| Variable | Required | Meaning |
|---|---|---|
| `EXPECT_CONTEXT` | yes | The kube context you intend to deploy to. The script refuses to run on any other context |
| `IMAGE` | yes | Image reference |
| `RUNAI_CONTROL_PLANE` | yes* | Control plane host, no scheme |
| `RUNAI_CLIENT_ID` / `_FILE` | yes* | Application name (literal or file path) |
| `RUNAI_CLIENT_SECRET` / `_FILE` | yes* | Application secret (prefer `_FILE`) |
| `HOST` | no | Ingress host. Default `clustermgr.<control plane host>` |
| `INGRESS` | no | `0` to skip the Ingress entirely |
| `INGRESS_CLASS` | no | Default: the cluster's default IngressClass, or the only one |
| `TLS_SECRET_SOURCE` | no | `namespace/name` of a TLS secret to copy into the app namespace. Without it the Ingress is HTTP only |
| `PULL_SECRET` / `ECR_REGION` | no | Registry credentials (see above) |
| `NAMESPACE` | no | Default `clustermgr` |
| `UI_USER` | no | Basic-auth user, default `admin` |
| `NO_FIT_STRATEGY` | no | `queue` (default) or `reject` |
| `EXCLUDE_CLUSTERS` | no | Comma list of cluster names/UUIDs never to place on |
| `ALLOW_UNKNOWN_CAPACITY` | no | Treat clusters with unknown GPU availability as available (default `false`) |
| `AUTO_CREATE_PROJECTS` | no | `true` = create a matching project on a cluster that lacks the chosen one, so any project works on any cluster. Needs project-create rights in Run:ai (default `false`) |
| `MOCK` | no | `1` = built-in demo data, no Run:ai calls |

\* not needed with `MOCK=1`.

## 4. Deploy

```bash
export KUBECONFIG=~/.kube/config-<name>
scripts/deploy.sh environments/<name>.env
```

The script is idempotent: re-running it applies changes and restarts the pod so new Secret values are picked up. It prints the URL and how to read the generated UI password.

### Access

- **Ingress**: `https://<HOST>`; sign in with the basic-auth user and the generated password.
- **Port-forward** (no ingress needed): `kubectl -n clustermgr port-forward svc/clustermgr 3000:80`, then <http://localhost:3000>.

Protect any exposed deployment. The app can submit workloads, so it always runs with basic auth when deployed by the script. For SSO, put an oauth2-proxy in front of the Service or use your ingress controller's external-auth annotations.

If the control plane's load balancer restricts source IPs (some deployments do), allow the egress address of the cluster hosting the manager.

## 5. Verify

```bash
kubectl -n clustermgr get pods
curl -s https://<HOST>/healthz                      # {"status":"ok"}
curl -su admin:<password> https://<HOST>/readyz     # 200 only if the Run:ai credentials work
```

In the UI the header shows `Connected to <control plane>` and each cluster card shows real GPU counts. A "Demo data" badge means `MOCK=1`.

## 6. Upgrade

1. Build and push a new immutable tag.
2. Change `IMAGE` in the env file, rerun `scripts/deploy.sh`.
3. After a **Run:ai upgrade**, regenerate the API contract and run the tests (see README, "After a Run:ai upgrade").

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Script says it refuses to deploy | The current kube context differs from `EXPECT_CONTEXT`. Switch context or `KUBECONFIG` |
| `ImagePullBackOff` | Registry credentials: set `PULL_SECRET`/`ECR_REGION`, or the ECR token expired: rerun the deploy |
| UI shows "Could not load clusters: ... rejected the application credentials" | Wrong `RUNAI_CLIENT_ID` or secret, or the application was deleted |
| `readyz` returns 503 | Same as above, or the control plane is unreachable from the cluster (DNS/firewall/split-horizon DNS) |
| A cluster is greyed out | It is not `Connected` in Run:ai, or the chosen project does not exist on it. The card says which |
| Values show as `—` | Run:ai did not return that telemetry. A banner lists what failed; the manager never guesses |
| Workload stays `Pending`: "No node in the default node-pool has GPU resources" | Run:ai scheduling, not the manager: set the project's default node pools to pools that have GPUs (and give it quota there) |
| Page hangs on a stale Run:ai UI after a control-plane upgrade | Clear site data for the Run:ai host (cached 2.x assets) |
