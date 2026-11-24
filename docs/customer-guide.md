# Deploying Run:ai Cluster Manager on your own clusters

A step-by-step guide for installing the Cluster Manager against **your** Run:ai control plane and clusters. Every value below that looks like `runai.example.com` or `my-app-name` is a placeholder; replace it with yours.

## How it fits together

```
 Your users ──► Cluster Manager (one small pod, any Kubernetes cluster)
                      │  HTTPS (Run:ai public API, app credentials)
                      ▼
          Run:ai control plane  ──►  cluster A, cluster B, cluster C …
```

- The manager talks **only to the Run:ai control plane's API**. It never connects to your clusters' Kubernetes API servers, and it holds no kubeconfigs for them.
- It schedules across all clusters **registered in that one control plane**. If you run several control planes, deploy one manager per control plane (one env file each).
- It can run in any Kubernetes cluster that can reach the control plane over HTTPS: one of your Run:ai clusters, a management cluster, or a small dedicated one. It needs about 50 mCPU and 64 MiB, and no GPU.

## What you need

| | |
|---|---|
| Run:ai | Control plane 3.0 or newer, with the clusters you want to schedule across already connected |
| Run:ai admin access | To create an *application* (service account) |
| A Kubernetes cluster to host the manager, and `kubectl` access | Any cluster that can reach the control plane on HTTPS (443) |
| A container registry that cluster can pull from | Or use GHCR (see step 2) |
| On your workstation | `kubectl`, `docker` with `buildx`, `node` 22+ (only for the optional checks), `openssl` |

## Step 1: Create a Run:ai application

The manager signs in as a Run:ai *application* (client credentials), not as a person.

1. In the Run:ai UI open **Settings → Access → Applications → New application**. Name it, for example, `cluster-manager`.
2. **Copy the secret now**: it is shown once. Save it to a file with tight permissions:

   ```bash
   mkdir -p ~/.secrets && chmod 700 ~/.secrets
   printf '%s' '<paste the secret>' > ~/.secrets/clustermgr.secret
   chmod 600 ~/.secrets/clustermgr.secret
   ```
3. Give the application an access rule (role + scope) that can do the following. Scope it to the clusters and projects you want the manager to use:

   | Capability | Why |
   |---|---|
   | View clusters | list clusters and connection state |
   | View nodes / metrics (telemetry) | free, total and allocated GPUs per cluster |
   | View projects | build the project list and quotas |
   | View workloads | recent workloads, pending/running counts |
   | Create workloads: workspaces, trainings, distributed trainings, inferences | submit |
   | *Only if you enable `AUTO_CREATE_PROJECTS`*: create projects | create a matching project on a cluster that lacks one |

   Run:ai role names differ by version; pick the built-in or custom role that grants the capabilities above. Step 7 tells you exactly what is missing if something is.

Keep the application's **name** (the client ID) handy.

## Step 2: Get the image

There is no shared public image; you build it once and push it where your cluster can pull it.

**Option A: build locally and push to your registry**

```bash
git clone https://github.com/chadchappy/runclustermgr.git
cd runclustermgr
docker buildx build --platform linux/amd64 \
  -t registry.example.com/runclustermgr:2.1.1 --push .
```

Use `--platform linux/amd64,linux/arm64` if your nodes are mixed or Arm. Use a new, immutable tag for every release (never `latest`).

**Option B: let GitHub Actions publish to GHCR.** Fork the repository, then push a tag (`git tag v2.1.1 && git push origin v2.1.1`). The workflow runs the tests and publishes `ghcr.io/<you>/runclustermgr:v2.1.1`. Make the package public, or create an image pull secret in step 4.

Private registry? Create the namespace and an image pull secret **before** the first deploy, and set `PULL_SECRET=<name>` in step 3:

```bash
kubectl create namespace clustermgr
kubectl -n clustermgr create secret docker-registry my-regcred \
  --docker-server=registry.example.com --docker-username=<user> --docker-password=<token>
```

For Amazon ECR just set `ECR_REGION=<region>` in step 3; the script creates and refreshes the pull secret itself.

## Step 3: Describe your environment

```bash
cp environments/example.env environments/prod.env
```

Edit `environments/prod.env`. The values you must set:

```bash
EXPECT_CONTEXT=prod-cluster                 # the kube context you will deploy to (see step 4)
IMAGE=registry.example.com/runclustermgr:2.1.1
RUNAI_CONTROL_PLANE=runai.example.com       # host only, no https://
RUNAI_CLIENT_ID=cluster-manager             # the application name from step 1
RUNAI_CLIENT_SECRET_FILE=~/.secrets/clustermgr.secret
```

Common options (all in the file, all commented in `example.env`):

| Setting | Use it to |
|---|---|
| `HOST=clustermgr.example.com` | choose the ingress hostname (default `clustermgr.<control plane host>`) |
| `INGRESS=0` | skip the Ingress; use port-forward only |
| `INGRESS_CLASS=nginx` | force an ingress class (default: the cluster's default class) |
| `TLS_SECRET_SOURCE=ns/secret-name` | copy an existing TLS secret into the app namespace (HTTPS) |
| `AUTO_CREATE_PROJECTS=true` | let any project be used on any cluster (creates it on demand) |
| `EXCLUDE_CLUSTERS=a,b` | never schedule on these clusters (names or UUIDs) |
| `NO_FIT_STRATEGY=reject` | refuse instead of queueing when nothing has free GPUs |

`environments/*.env` is git-ignored on purpose: it names your clusters, registry and application. Do not commit it. It contains no secret values (the secret is referenced by file path).

## Step 4: Point `kubectl` at the host cluster

```bash
export KUBECONFIG=~/.kube/config-prod       # or merge into your default config
kubectl config get-contexts                 # find the NAME you want
kubectl config use-context prod-cluster
kubectl get nodes                           # sanity check
```

`EXPECT_CONTEXT` must match the current context name. The deploy script refuses to run otherwise, so you cannot deploy to the wrong cluster by accident.

## Step 5: Deploy

```bash
scripts/deploy.sh environments/prod.env
```

It creates the `clustermgr` namespace, stores your credentials in a Kubernetes Secret, generates a UI password, optionally copies the TLS secret and refreshes the registry secret, renders and applies the manifests, and waits for the rollout. At the end it prints the URL and how to read the password. It is safe to re-run.

## Step 6: Open the app

**Port-forward** (works everywhere, no DNS or ingress needed):

```bash
kubectl -n clustermgr port-forward svc/clustermgr 3000:80
```

Open **http://localhost:3000** (plain `http`, not `https`). Sign in as `admin` with the generated password:

```bash
kubectl -n clustermgr get secret clustermgr-secrets -o jsonpath='{.data.UI_PASSWORD}' | base64 -d; echo
```

**Ingress**: `https://<HOST>` (or `http://` if you did not configure TLS). Create a DNS record for `HOST` pointing at your ingress controller's address. If your control plane uses a wildcard certificate and DNS (for example `*.runai.example.com`), the default hostname `clustermgr.runai.example.com` needs no extra DNS work; set `TLS_SECRET_SOURCE` to the wildcard certificate secret to get HTTPS.

## Step 7: Verify

```bash
kubectl -n clustermgr get pods                                         # 1/1 Running
curl -s http://localhost:3000/healthz                                  # {"status":"ok"} (with port-forward)
curl -su admin:<password> http://localhost:3000/readyz                 # {"status":"ready"}: Run:ai credentials work
```

`readyz` returning 503 means the pod cannot sign in to Run:ai (wrong application name/secret, or the control plane is unreachable; see Troubleshooting).

Then run the read-only API compatibility check from your workstation. It reports exactly which capability is missing if the application's access rule is too narrow:

```bash
RUNAI_CONTROL_PLANE=runai.example.com RUNAI_CLIENT_ID=cluster-manager \
RUNAI_CLIENT_SECRET_FILE=~/.secrets/clustermgr.secret node scripts/check-live.mjs
```

Optional end-to-end test through the deployed app. It submits one tiny workload of each type to a project you name, checks placement, and deletes them. It consumes a little GPU and CPU quota, so pick a suitable project:

```bash
BASE_URL=http://localhost:3000 UI_USER=admin UI_PASSWORD=<password> PROJECT=<your-project> \
RUNAI_CONTROL_PLANE=runai.example.com RUNAI_CLIENT_ID=cluster-manager \
RUNAI_CLIENT_SECRET_FILE=~/.secrets/clustermgr.secret node scripts/qa-live.mjs
```

## Using it

- Each cluster appears as a card with live free and total GPUs.
- **Schedule automatically** (default) sends the workload to the cluster with the most free GPUs. Turn it off, or click a cluster, to choose one yourself.
- Pick a **project**. The same project name must exist on a cluster for it to be eligible, unless you enabled `AUTO_CREATE_PROJECTS`.
- The **placement preview** shows how every cluster ranks and why before you submit.

## Network checklist

The manager needs outbound HTTPS from its pod to the control plane. If something does not work, check these in order:

1. **DNS from inside the cluster.** Private/split-horizon DNS can resolve the control plane's hostname to a different address inside your network than outside. Test from a pod:
   ```bash
   kubectl run dnscheck --rm -it --restart=Never --image=curlimages/curl -- \
     curl -sv https://runai.example.com/api/v1/token -o /dev/null
   ```
   You should see the control plane's certificate. A wrong or self-signed certificate (for example `ingress.local`) means DNS points somewhere else.
2. **Source-IP allow lists.** If the control plane's load balancer or firewall only accepts listed source IPs, add the **egress (NAT) IP of the cluster hosting the manager** for port 443.
3. **Private CA.** If the control plane uses a certificate from a private CA, the pod must trust it. Node.js supports `NODE_EXTRA_CA_CERTS=/path/ca.pem`; mount the CA into the pod and set that variable (the stock manifest does not do this for you yet).
4. **HTTP proxy.** The manager does not read proxy settings. Use a cluster with direct egress to the control plane.

## Several environments

Make one env file per control plane (`environments/prod.env`, `environments/staging.env`), each with its own `EXPECT_CONTEXT`, `RUNAI_CONTROL_PLANE`, credentials file and hostname, and deploy each with `scripts/deploy.sh <file>`. They are fully independent.

## Operations

| Task | How |
|---|---|
| Upgrade | build and push a new tag, change `IMAGE`, rerun `scripts/deploy.sh` |
| After upgrading Run:ai | `curl -s https://<control-plane>/api/docs -o openapi.yaml`, convert to JSON (`yq -o=json . openapi.yaml > openapi.json`), `npm run contract -- openapi.json`, `npm test` |
| Rotate the Run:ai secret | create a new one in Run:ai, overwrite the secret file, rerun the deploy script |
| Rotate the UI password | `kubectl -n clustermgr delete secret clustermgr-secrets`, rerun the deploy script (a new password is generated; read it with the command in step 6) |
| Logs | `kubectl -n clustermgr logs deploy/clustermgr` (JSON lines; secrets are never logged) |
| Uninstall | `kubectl delete namespace clustermgr` |

## Security notes

- The manager has the privileges of its Run:ai application and can create workloads. Scope the application to only the projects you want it to submit to.
- The UI is protected by HTTP basic auth. For single sign-on, put an `oauth2-proxy` in front of the Service or use your ingress controller's external-auth support.
- Credentials live only in the Kubernetes Secret and in your local secret file. Nothing secret is in the image, the manifests or the repository.
- The pod runs non-root on a read-only filesystem with all capabilities dropped and no service-account token.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Deploy script: "Refusing to deploy: current context is …" | `EXPECT_CONTEXT` does not match the active context. Switch context or fix the env file |
| `ImagePullBackOff` | The cluster cannot pull `IMAGE`. Set `PULL_SECRET`/`ECR_REGION`, or make the package public. ECR tokens expire after ~12 h: redeploy to refresh |
| `readyz` 503 / UI banner "rejected the application credentials" | Wrong `RUNAI_CLIENT_ID` or secret, or the application was deleted. Check with `check-live.mjs` |
| UI banner "Run:ai … unreachable" | DNS, firewall or certificate problem: see the Network checklist |
| `check-live.mjs` fails on one endpoint | The application's access rule lacks that capability (the failing endpoint names it) |
| A cluster is greyed out | It is not *Connected* in Run:ai, or the project does not exist on it (enable `AUTO_CREATE_PROJECTS` or create the project) |
| GPU numbers show `—` | Run:ai returned no telemetry for that cluster; the banner lists what failed. The manager never guesses |
| A workload stays *Pending* | A Run:ai scheduling matter, not the manager: check the project's quota and default node pools on that cluster (a node pool with no GPUs cannot run GPU work) |
| `http://localhost:3000` "invalid response" / SSL error | Use `http://`, not `https://`, with the port-forward |
| Browser hangs on an old Run:ai UI after a control-plane upgrade | Clear site data for the Run:ai hostname (cached assets from the previous version) |
