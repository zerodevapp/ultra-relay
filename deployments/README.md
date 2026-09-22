# Deployments

Values files that ArgoCD renders through SRE's shared `generic-application`
Helm chart to run ultra-relay on EKS (us-east-2). **Merging a change to any
file here deploys it to production.** Design and assumptions:
`docs/adr/0002-eks-deployment-via-ecr-and-gitops-rollouts.md`.

## Layout

| File | Purpose |
|---|---|
| `common.values.yaml` | Shared by every relay instance. Never holds an image tag. |
| `ultra-relay-<name>.values.yaml` | One relay instance (one process, one chain). Holds its name, image tag, `config.json`, and Secrets Manager mapping. |

A **relay instance** is named `ultra-relay-<chain>` or
`ultra-relay-<chain>-<variant>` (see `CONTEXT.md`). The filename stem must
equal `application.applicationName`; CI enforces it together with the image
tag location, the config JSON and the required secret mappings
(`scripts/deployments/check.py`).

## Release → rollout

Nothing deploys automatically. Building and rolling out are two steps.

1. **Merge a code PR to main.** The `Build and push image to ECR` workflow
   builds the image, pushes it to ECR as `main-<sha>`, and creates GitHub
   release `v<run number>`. The cluster is untouched. Re-running that
   workflow is safe: if the image tag already exists the build is skipped and
   the existing release is kept.
2. **Run `Create deploy PR`** (Actions tab → Run workflow, from `main`).
   Choose the instances (`all` or a comma-separated list) and optionally a
   release (`v42`; empty = the highest-numbered published release). It
   verifies the image exists in ECR and opens a PR that changes only the
   `tag:` line in the chosen instance files. If a deploy PR for the same
   release and instances is already open, the run stops and points at it, so
   edits you made on that PR are never overwritten.
3. **Review and merge the deploy PR.** ArgoCD notices main changed, re-renders
   the chart and replaces the pod. Rolling replacement: the new pod starts
   before the old one stops.

**Rollback:** run `Create deploy PR` with the previous release, or revert the
deploy PR. **Config change** (anything in `config.json`, resources, probes):
an ordinary PR editing the values file; merging it re-rolls the pod.

Deploy PRs are opened with the built-in `GITHUB_TOKEN`, which needs the repo
setting *Settings → Actions → General → "Allow GitHub Actions to create and
approve pull requests"*. CI does not run on PRs opened by that token: GitHub
creates no workflow runs for events the built-in token triggers, so there is
nothing to approve. The `Check deployment values` workflow runs on main right
after the merge instead. To get a pre-merge run, close and reopen the PR,
which re-triggers `pull_request` as you. Upgrade path: an org-owned GitHub App
token, as doorway-kms uses.

## Rolling out a branch

1. Actions tab → `Build and push image to ECR` → Run workflow → pick the
   branch (leave `dry_run` off). The run's summary shows the tag,
   `<branch>-<sha>` (a `/` in the branch name becomes `-`, so `feat/x` builds
   `feat-x-<sha>`). No release is created.
2. `Create deploy PR` with `image_tag` set to that tag. Merge it.
3. Prod keeps running the branch image until the next deploy PR. After the
   branch merges to main, roll out its release as usual.

If the branch also needs a config change, push it to the deploy PR's branch
by hand before merging: ArgoCD reads the values files from main only. Do not
re-run `Create deploy PR` for that branch afterwards; it would stop anyway
because the PR is open.

## Adding a relay instance

1. Copy an existing instance file to `deployments/<new-name>.values.yaml`.
   Set `applicationName`, the ConfigMap volume name (`<new-name>-config`),
   the ExternalSecret name (`<new-name>-secrets`), every `remoteRef.key`
   (`k8s__ultra-relay_<variant>`, the name without its `ultra-relay-`
   prefix) and the IRSA role annotation, then edit `config.json`. Keep every
   required secret mapping; CI fails if one is missing or renamed. Set
   `tag:` to the
   placeholder `main-0000000`: a file copied from a live instance carries a
   real tag, and ArgoCD would deploy that image the moment it discovers the
   new application, before any deploy PR.
2. Ask SRE for Secrets Manager secret `k8s__ultra-relay_<variant>` in the
   cluster account, a JSON object with keys `executor-private-keys`,
   `utility-private-key`, `rpc-url` and `redis-events-queue-endpoint`, plus
   an IRSA role `external-secrets-<new-name>-ue2` allowed to read it. The
   queue name is not a secret; it lives in `config.json`.
3. Open a PR; `Check deployment values` must pass. Merge.
4. Ask SRE to add a component entry for the new instance in
   `charts/zerodev/config/zerodev-prod-ue2-v1/config.yaml` of
   `OffchainLabs/zerodev-helm-charts` (snippet under Prerequisites); ArgoCD
   creates the application from it.
5. Run `Create deploy PR` for the new instance.

`scripts/deployments/test.sh` runs the script tests locally.

## Secrets and config

- Non-secret settings live in `config.json` inside the values file. The
  container reads it via `ALTO_CONFIG=/config/config.json`. A config edit
  re-rolls the pod through the chart's ConfigMap checksum.
- Secret settings live in Kubernetes Secret `<instance>-secrets`, which
  External Secrets Operator syncs from Secrets Manager
  `k8s__ultra-relay_<variant>`. Its keys are the upper-cased property names
  (`RPC_URL`, `EXECUTOR_PRIVATE_KEYS`, ...); `common.values.yaml` maps each
  one to the `ALTO_*` env var the CLI reads. Env vars take precedence over
  the config file, and CI rejects a config file that contains a secret key.
  A rotated
  secret restarts the pod only if the Reloader controller runs on the
  cluster (SRE prerequisite); otherwise restart the pod by hand.

## Exposure

Each instance gets an internal AWS Network Load Balancer (Service type
`LoadBalancer`, internal scheme), port 80 → container 3000. The caller in
Render reaches it over VPC peering by the load balancer's DNS name. There is
no public hostname.

## Prerequisites owned by SRE (before the first sync)

- ECR repository `offchain-labs/ultra-relay` in the management account
  `352956043285`, region us-west-2 (where every other ZeroDev image lives;
  the cluster pulls cross-region and cross-account), **with immutable tags**
  and a repository policy that lets the `zerodev-prod-ue2-v1` node role pull.
- IAM role `ultra-relay-gha` for GitHub OIDC (created by SRE), trusting
  `repo:zerodevapp/ultra-relay:*`, with ECR push and `ecr:DescribeImages`.
- Target cluster: `zerodev-prod-ue2-v1` (us-east-2, AWS account
  `518033442333`), defined by SRE in `OffchainLabs/zerodev-helm-charts`.
- ArgoCD registration: one component per relay instance in
  `charts/zerodev/config/zerodev-prod-ue2-v1/config.yaml` of
  `OffchainLabs/zerodev-helm-charts`. That repo's app-of-apps chart turns each
  component into an ArgoCD Application named
  `zerodev-prod-ue2-v1-ultra-relay-<instance>` that pulls
  `generic-application` from the internal chart museum and the values from
  this repo, the same way the `kms-breakglass` component points at
  `breakglass/deployments/`. Values stay in this repo on purpose; only the
  entry lives in the charts repo:

  ```yaml
  ultra-relay-arbitrum-ostium:
    namespace: ultra-relay
    enabled: true
    syncPolicy:
      automated:
        prune: true
        selfHeal: true
    ignoreDifferences:
      # Reloader's rollout annotation must not be reverted by self-heal.
      - group: apps
        kind: Deployment
        jqPathExpressions:
          - '.spec.template.metadata.annotations."reloader.stakater.com/last-reloaded-from"'
    sources:
      - repoURL: https://chartmuseum-internal-repo.tail6f50.ts.net
        chart: generic-application
        targetRevision: 0.0.14 # SRE's choice; 0.0.12 and 0.0.14 are in use
        helm:
          releaseName: ultra-relay-arbitrum-ostium
          valueFiles:
            - $values/deployments/common.values.yaml
            - $values/deployments/ultra-relay-arbitrum-ostium.values.yaml
      - repoURL: https://github.com/zerodevapp/ultra-relay
        targetRevision: main
        ref: values
  ```
- One IRSA role per instance for External Secrets Operator in account
  `518033442333`, `external-secrets-<instance>-ue2`, allowed to read that
  instance's `k8s__ultra-relay_<variant>` secret. It is set in the instance
  file's `external-secret.serviceAccount` block; the role in
  `common.values.yaml` is only a default.
- AWS Load Balancer Controller and the Reloader controller on the cluster
  (Prometheus Operator too for metrics; without its CRD the chart simply
  skips the ServiceMonitor); a security-group rule admitting Render's peered
  CIDR on the NLB listener; VPC peering to Render (Virginia) in both
  directions (caller → NLB, pod → Redis).
- The first Secrets Manager secret populated.

If the role's trust policy or the repository policy is wrong, the first
push-to-main build fails at the AWS login or push step. That is harmless:
re-run it once SRE has fixed it. `dry_run` builds need no AWS at all.
