# Run:ai Multi-Cluster Scheduling Portal

Multi-cluster workload placement for NVIDIA Run:ai. Submit a workload once; by default it goes to the connected cluster with the **most available GPUs**, or you pick the cluster yourself.

- Works across all clusters registered in one Run:ai control plane (v3.0+ API).
- **Schedule automatically** (default) or choose a cluster by hand, per workload.
- Optionally use any project on any cluster: a missing project is created on demand (`AUTO_CREATE_PROJECTS`).
- Real telemetry only: free/total/allocated GPUs come from `GET /api/v1/nodes/telemetry`. Missing data shows as "unknown", never as a guess.
- Creates workspaces, trainings, distributed trainings (PyTorch, TF, MPI, XGBoost, JAX) and inference workloads through the public Run:ai API.
- No `npm install` and no build step: Node 22+ built-ins plus one vendored library (js-yaml, MIT, in `server/vendor/`).
- **Paste a Kubernetes manifest (YAML) or a `runai` CLI command** instead of filling the form, with live syntax checking.

## Using the UI

Open the app (ingress URL, or `kubectl -n clustermgr port-forward svc/clustermgr 3000:80` then <http://localhost:3000>) and sign in.

- **Cluster cards** show live free/total GPUs, running and pending workloads and the Run:ai version. The recommended cluster is highlighted.
- **Schedule automatically** (switch, on by default) sends the workload to the cluster with the most free GPUs. Turn it off, click a cluster button, or click a cluster card to choose the cluster yourself; click the chosen card again to return to automatic.
- **Placement preview** ranks every cluster for the current form values and explains each result, including when your manual choice is not the most open cluster.
- **Project** lists every project from every cluster. With `AUTO_CREATE_PROJECTS` on, a hint shows where the project will be created on demand.
- **Submit** with the form (workspace, training, distributed, inference) or by pasting **YAML** or a **Run:ai CLI** command (see below), then check **Recent workloads** across clusters.

## YAML and CLI input

The **YAML** and **Run:ai CLI** tiles take the same input the Run:ai CLI does, so existing manifests and commands can be pasted as they are. They share the cluster choice (automatic or manual), the project selector and the placement preview with the form.

Both are checked as you type. Errors name the line and column, are marked in the editor gutter, and you can click one to jump to it. Submit stays blocked until the input is valid.

**YAML tile.** A Kubernetes manifest for one workload: the format `runai workload submit -f` takes (submitted through `POST /api/v2/workloads`). The project is the one selected above. Checked: YAML syntax (indentation, tabs, duplicate keys, unclosed quotes and brackets), a single document, `apiVersion`, `kind`, `metadata.name` (or `generateName`), and that the kind is a workload (not a Secret, Service, Namespace, ...). GPUs are counted from `nvidia.com/gpu` limits/requests times replicas or parallelism so placement knows how much room is needed; enter "GPUs for placement" to override. Run:ai still validates the content when it receives it and its message is shown if it rejects the manifest.

**CLI tile.** A `runai ... submit ...` command line (CLI 3.x): `workspace`, `training` (standard, `pytorch`, `mpi`) and `inference` submits. It is parsed, never executed through a shell. Supported flags: `-p/--project`, `-i/--image`, `-g/--gpu-devices-request`, `--gpu-portion-request`, `--cpu-core-request`, `--cpu-memory-request`, `-e/--environment-variable`, `--command` with `-- args`, `--name-prefix`, `--workers` (pytorch, mpi) and `--serving-port` (inference). Without `-p` the selected project is used. Checked against the CLI's own definitions (`contract/runai-cli.json`, generated from `runai --help`): unknown commands and flags with did-you-mean suggestions, value types (numbers, durations, enums), missing name/project/image, shell syntax that cannot be honoured (pipes, `&&`, `$VARS`, unterminated quotes). Flags that are valid in the CLI but not supported here (volumes, templates, node pools, ...) are **refused rather than silently dropped**; use the YAML tile for those. `runai workload submit -f file.yaml` reads a file from your disk, so paste the manifest into the YAML tile instead.

Regenerate the CLI model after upgrading the CLI: `node scripts/gen-cli-spec.mjs` then `npm test`.

## How placement works

A cluster is **eligible** if it is connected, the project exists on it (or `AUTO_CREATE_PROJECTS` is on), it is not excluded by policy, and the request does not exceed the project's GPU limit there. Eligible clusters are ranked by:

1. fits right now (known free GPUs >= requested)
2. most free GPUs (minus GPUs reserved by recent in-flight submissions, which keeps a burst of submissions from piling onto one cluster while telemetry catches up)
3. fewest pending workloads
4. lowest allocation ratio
5. name (deterministic)

You can override the automatic choice (see *Using the UI* below) and the workload goes to the cluster you pick if it is eligible. With `AUTO_CREATE_PROJECTS=true` every project is usable on every connected cluster: when a workload lands on a cluster that has no project of that name, the app creates it there first (no guaranteed quota; it runs on over-quota capacity), waits for it to be ready, then submits. Per-user project visibility is not implemented yet: everyone sees all projects.

If nothing fits, the workload is **queued** on the least-loaded eligible cluster (`NO_FIT_STRATEGY=queue`, default) or rejected (`reject`). The UI shows the ranking and the reason for every cluster before you submit.

Failure handling: if the chosen cluster answers `503` (workload definitely not created) the next eligible cluster is tried. Timeouts and `500`s are *not* retried elsewhere because the workload may exist, and a retry could create a duplicate.

## Run it

```bash
# Offline demo for development only (built-in fake data; never used in a real deployment)
MOCK=1 npm start                      # http://localhost:3000

# Against a control plane
export RUNAI_CONTROL_PLANE=your-control-plane.example.com
export RUNAI_CLIENT_ID=<application name>
export RUNAI_CLIENT_SECRET=<application secret>
npm start
```

Create the application in Run:ai under *Settings → Access → Applications*. It needs permission to read clusters, projects, nodes/telemetry and workloads, and to create workloads in the projects you use.

| Variable | Default | Purpose |
|---|---|---|
| `RUNAI_CONTROL_PLANE` | | control plane host, no scheme |
| `RUNAI_CLIENT_ID` / `RUNAI_CLIENT_SECRET` | | app credentials. `*_FILE` variants read a mounted file |
| `UI_USER` / `UI_PASSWORD` | off | HTTP basic auth for UI and API (health check stays open) |
| `NO_FIT_STRATEGY` | `queue` | `queue` or `reject` |
| `EXCLUDE_CLUSTERS` | | comma list of cluster names/uuids never to use |
| `ALLOW_UNKNOWN_CAPACITY` | `false` | treat clusters with unknown GPU availability as available |
| `AUTO_CREATE_PROJECTS` | `false` | use any project on any cluster: create a matching project (no guaranteed quota) on a cluster that lacks it |
| `CAPACITY_TTL_MS` | `15000` | telemetry cache |
| `RESERVATION_TTL_MS` | `90000` | how long a submission reserves GPUs |
| `PORT` | `3000` | |

## Deploy to Kubernetes

**Installing for your own clusters?** Follow the step-by-step [customer guide](docs/customer-guide.md): create a Run:ai application, build the image, fill in one env file, run one script.

The short version:

```bash
cp environments/example.env environments/prod.env     # edit: context, image, control plane, app name
printf '%s' '<application secret>' > ~/.secrets/clustermgr.secret && chmod 600 ~/.secrets/clustermgr.secret
export KUBECONFIG=~/.kube/config-prod
scripts/deploy.sh environments/prod.env
```

The script:

- **refuses to run** unless the current kube context equals `EXPECT_CONTEXT`
- stores credentials in a Kubernetes Secret (never in git or manifests) and generates the UI password once
- defaults the hostname to `clustermgr.<control plane host>` and auto-detects the ingress class
- copies an existing TLS secret (`TLS_SECRET_SOURCE`) and refreshes an ECR pull secret (`ECR_REGION`) if you ask
- works without any ingress (`INGRESS=0`): `kubectl -n clustermgr port-forward svc/clustermgr 3000:80`

`environments/*.env` is git-ignored (it names your clusters and registry); only `example.env` is tracked. See [docs/deployment.md](docs/deployment.md) for every option and registries.

The pod runs a single replica (in-flight reservations live in memory), non-root, on a read-only filesystem with all capabilities dropped.

Image: `docker buildx build --platform linux/amd64 -t <registry>/runclustermgr:<tag> .` CI (`.github/workflows/ci.yml`) runs the tests and publishes to GHCR on `v*` tags.

## Tests

```bash
npm test
```

- **placement**: ranking, tie-breaks, quota limits, fractional GPUs, queueing, reservations.
- **payloads + contract**: every field sent to Run:ai is checked against `contract/workload-contract.json`, generated from the control plane's OpenAPI spec (`/api/docs`).
- **client**: token reuse and refresh, retry rules, pagination.
- **capacity**: telemetry parsing, missing data becomes `null`.
- **api (end to end)**: real HTTP server against an in-process fake Run:ai API that enforces the same contract (unknown fields get a 400, like the real API): submission for all workload types, fallback, no-duplicate rules, auth, path traversal, body limits.

### Check against a real control plane

Two scripts talk to a live Run:ai (credentials as for `npm start`):

```bash
# Read-only: every endpoint/response shape this app depends on. Exit 1 if anything changed.
RUNAI_CONTROL_PLANE=... RUNAI_CLIENT_ID=... RUNAI_CLIENT_SECRET_FILE=... node scripts/check-live.mjs

# End to end through a deployed app: submits one small workload of each type
# (training, workspace, distributed PyTorch + MPI, inference), checks placement, deletes them.
BASE_URL=https://clustermgr.example.com UI_USER=admin UI_PASSWORD=... PROJECT=my-project \
RUNAI_CONTROL_PLANE=... RUNAI_CLIENT_ID=... RUNAI_CLIENT_SECRET_FILE=... node scripts/qa-live.mjs
```

### After a Run:ai upgrade

```bash
curl -s https://<control-plane>/api/docs -o openapi.yaml
yq -o=json . openapi.yaml > openapi.json
npm run contract -- openapi.json   # regenerates contract/workload-contract.json
npm test                           # failures show exactly which fields changed
```

## API

| | |
|---|---|
| `GET /api/clusters` | capacity snapshot (`?refresh=1` bypasses cache) |
| `GET /api/projects` | projects and the clusters that have them |
| `POST /api/validate` | syntax-check pasted YAML or a CLI command: `{ source: 'yaml'\|'cli', text, project? }` returns errors with line/column, warnings and a summary |
| `POST /api/placement` | dry run: ranking and reasons, nothing is submitted |
| `POST /api/workloads` | place and submit; `pinnedClusterId` forces a cluster. Body is a form request, or `{ source: 'yaml'\|'cli', text, project?, gpus? }` |
| `GET /api/workloads` | recent workloads across clusters |
| `GET /api/decisions` | recent placement decisions |
| `GET /healthz`, `/readyz` | liveness; readiness (verifies Run:ai credentials) |

Request body: `{ type: workspace|training|distributed|inference, name, project, image, gpus, cpu?, memory?, command?, args?, env?, framework?, workers?, port?, pinnedClusterId? }`. An optional `nodePool` is passed through to Run:ai untouched (the UI does not expose it). `gpus` below 1 requests a fractional GPU.

## More documentation

- [docs/customer-guide.md](docs/customer-guide.md): start-to-finish install on your own clusters (Run:ai application, image, deploy, verify, network checklist)
- [docs/deployment.md](docs/deployment.md): environments, registries, ingress/TLS, access control, upgrades, troubleshooting
- [docs/architecture.md](docs/architecture.md): components, data flow, placement algorithm, failure semantics, Run:ai API usage

## Prerequisites in Run:ai

- Project names: without `AUTO_CREATE_PROJECTS`, the same project name must exist on every cluster you want to schedule across (placement skips clusters that lack it). With it on, the app creates missing ones on demand using its Run:ai application, which therefore needs permission to create projects.
- The project needs GPU quota and usable **default node pools** on each cluster. The app places at the cluster level and Run:ai picks the node pool; if a project's default pool has no GPUs, Run:ai leaves the pod `Pending` ("No node in the default node-pool has GPU resources"). Fix it in Run:ai by setting the project's default node pools.

## Limits

- Clusters must be registered in the same control plane. Separate control planes are not aggregated.
- Reservations are per process; running several replicas would make bursts less even.
- Live data depends on the telemetry types `TOTAL_GPUS`, `FREE_GPUS`, `ALLOCATED_GPUS`, `READY_GPUS` being available.

## Branding

The NVIDIA wordmark and favicon in `web/assets/` are NVIDIA brand assets copied unmodified from the Run:ai product UI. They remain NVIDIA trademarks; use them in line with NVIDIA's brand guidelines, or replace the files.

## Security notes

- No credentials in the repository. **The previous version committed an application secret; it must be treated as compromised and rotated if it was ever valid, and removed from git history.**
- The UI renders API data with `textContent` only and sends a strict CSP.
- Enable `UI_USER`/`UI_PASSWORD` (the deploy script always does) when exposing through an ingress; the app can submit workloads.
