# Architecture

```
Browser ──► Scheduling Portal (Node, single process)
              ├─ web/        static UI (no dependencies)
              ├─ server/
              │   ├─ runai-client.js   token + retry + pagination
              │   ├─ capacity.js       per-cluster GPU snapshot
              │   ├─ placement.js      pure ranking function + reservations
              │   ├─ payloads.js       request -> Run:ai creation payload
              │   └─ service.js        place / submit / fallback
              └─ contract/   field names + enums generated from the Run:ai OpenAPI spec
                              │ HTTPS (client_credentials)
                              ▼
                     Run:ai control plane (all registered clusters)
```

The manager is stateless apart from a 15 s capacity cache, a list of recent decisions, and in-flight GPU reservations (all in memory).

## Data it reads

| Need | API |
|---|---|
| Clusters, connection state | `GET /api/v1/clusters` (`status.state == Connected`) |
| Free/total/allocated/ready GPUs per cluster | `GET /api/v1/nodes/telemetry?telemetryType=FREE_GPUS\|TOTAL_GPUS\|ALLOCATED_GPUS\|READY_GPUS&groupBy=ClusterId` |
| Which cluster has your project, and its GPU quota | `GET /api/v1/org-unit/projects` |
| Pending / running counts | `GET /api/v1/workloads?filterBy=phase==Pending` (and `Running`) |
| Recent workloads | `GET /api/v1/workloads` |
| Submit | `POST /api/v1/workloads/{workspaces,trainings,distributed,inferences}` |
| On-demand project (opt-in) | `GET /api/v1/node-pools`, `POST /api/v1/org-unit/projects` (deserved GPU 0, over-quota weight 1; retried without the weight on clusters with over-quota off) |
| Auth | `POST /api/v1/token` with `grantType: client_credentials` |

Any value the API does not return is `null` ("unknown") and the UI shows `—`. Placement treats unknown capacity as "cannot verify" and will not call it a fit.

## Placement

Input: a request (project, total GPU demand) and the capacity snapshot. Demand is `gpus` for single-pod workloads and `gpus × (workers + master)` for distributed ones (an MPI launcher is not counted). Fractions below 1 are a share of one GPU.

1. **Eligibility (hard constraints)**: connected, project exists on the cluster, not excluded by policy, demand within the project's GPU limit there, matches the pinned cluster if one was requested.
2. **Order** among eligible clusters: fits now, then most free GPUs (after in-flight reservations), then fewest pending, then lowest allocation ratio, then name.
3. **Nothing fits**: queue on the eligible cluster with the fewest pending (then most free) or reject, per `NO_FIT_STRATEGY`.

`placement.js` is pure and fully unit tested. The same ranking is returned by the dry-run endpoint, so the UI preview and the actual decision cannot diverge.

### Reservations

Run:ai telemetry lags a submission by seconds. After each submission the manager reserves the requested GPUs on the chosen cluster for 90 s (configurable) and subtracts them from free capacity. A failed submission releases its reservation. This is why four rapid 4-GPU submissions across two 8-free clusters split two and two instead of all landing on one.

## Pasted input: YAML manifests and CLI commands

`server/intake.js` turns pasted text into a workload request, so the rest of the pipeline (placement, reservations, fallback, on-demand projects) is identical for the form, YAML and CLI.

| | YAML tile | CLI tile |
|---|---|---|
| Input | one Kubernetes manifest | one `runai ... submit ...` command |
| Parser | js-yaml (vendored), with line/column from the parser | shell-style tokenizer that never expands or executes anything |
| Model | Kubernetes object shape (apiVersion, kind, metadata.name) | `contract/runai-cli.json`, generated from `runai --help` by `scripts/gen-cli-spec.mjs` |
| Submitted as | `POST /api/v2/workloads` with `{ metadata: { name?, projectId }, manifestBase64Encoded }` | the same v1 endpoints as the form |
| GPU need | `nvidia.com/gpu` limits/requests x replicas/parallelism (overridable) | `-g` / `--gpu-portion-request` (x workers for distributed) |

`POST /api/validate` runs the same parser without side effects and returns `{ ok, errors:[{line,column,message}], warnings, summary }`; `/api/placement` and `/api/workloads` accept `{ source, text, project }` and fail with `400` and `Line N:C ...` details when the input is invalid, before anything is sent to Run:ai.

Design rules: a flag or field that cannot be honoured is an error (never silently dropped); `projectId` alone selects the cluster for manifests (`projectId` and `clusterId` are mutually exclusive on that endpoint, and the project belongs to one cluster); manifest and CLI text are never logged or echoed back.

## Choosing a cluster

Automatic placement uses the ranking above. A manual choice (`pinnedClusterId`) restricts the candidates to that one cluster: it is used when eligible, even if it has to queue, and the response says why when it is not. The UI always ranks every cluster so you can compare before overriding.

### Projects across clusters

Run:ai projects belong to one cluster. With `AUTO_CREATE_PROJECTS=true` a cluster that lacks the requested project is still eligible (flagged `createsProject`); on submit the service creates it (`deserved` GPU 0 on the cluster's default node pool, so workloads run on over-quota capacity), waits up to ~20 s for `status.phase == Ready`, then submits. A project created concurrently by someone else (HTTP 409) is picked up instead of failing. Dry-run placement never creates anything. Identity-based project visibility is intentionally not implemented yet.

## Failure semantics

| Event | Behaviour |
|---|---|
| Invalid request | `400` with every field error; nothing sent to Run:ai |
| No eligible cluster | `409` listing the reason per cluster |
| `503` from the chosen cluster | Treated as "not created"; the next eligible cluster is tried once |
| Timeout or `500` on submit | **Not** retried elsewhere (the workload may exist). Returned as `502` |
| `4xx` from Run:ai | Passed through with Run:ai's message |
| `401` mid-session | Token refreshed once, request retried |
| GET failures | Retried with backoff (network, `429`, `5xx`) |
| Control plane unreachable | `502`; the UI shows a banner and keeps the last data |

## API compliance

`contract/workload-contract.json` lists, per workload type, the allowed top-level, `spec` and `compute` fields plus enums (`gpuRequestType`, `distributedFramework`, serving protocol). It is generated from the control plane's own spec (`/api/docs`) by `scripts/gen-contract.js`. Two things use it:

- `test/contract.test.js` builds payloads for every type and variant and fails if any field is not in the spec.
- The in-process fake Run:ai API (`server/mock-runai.js`) rejects unknown fields with a `400`, so end-to-end tests fail the way production would.

The first version of this app sent `compute.cpu` and `compute.memory` (not in the API; the real fields are `cpuCoreRequest` and `cpuMemoryRequest`). A regression test pins that.

## Security

- Credentials only in a Kubernetes Secret or a mounted file. There are no defaults in code.
- UI and API behind HTTP basic auth (constant-time compare). `/healthz` is open for probes.
- Strict CSP (`default-src 'self'`), `X-Frame-Options: DENY`, `nosniff`. The UI renders server data via `textContent` only.
- Request bodies are capped at 1 MB; static file serving rejects path traversal.
- Container: non-root, read-only root filesystem, all capabilities dropped, no service-account token mounted.
- The manager has the privileges of its Run:ai application. Grant only the projects you want it to submit to.
