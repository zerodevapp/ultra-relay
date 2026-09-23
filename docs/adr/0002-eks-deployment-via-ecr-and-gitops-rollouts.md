---
status: accepted
date: 2026-09-09
---

# EKS deployment via ECR images and GitOps rollouts

Ultra Relay runs on Render today, one service per chain. We are moving it to
AWS EKS (us-east-2), deployed by ArgoCD through SRE's shared
`generic-application` Helm chart. We adopt the pattern already used by the
other ZeroDev services on EKS (doorway-kms, breakglass) rather than the
arbitrum-indexer pattern we were pointed at: **every merge to main builds an
image and cuts a release, but nothing deploys until a deploy PR bumps an image
tag in a values file on main.** This separates "code is ready" from "ship it",
leaves an audit trail in PRs, and lets a branch image reach prod without ArgoCD
ever leaving main.

## Decisions

- **Relay instance = one values file.** A relay instance (see CONTEXT.md) is
  one process serving one chain, named `ultra-relay-<chain>` or
  `ultra-relay-<chain>-<variant>`. Each is `deployments/<instance>.values.yaml`,
  layered on `deployments/common.values.yaml`, and becomes its own ArgoCD
  application, Deployment, Service, ConfigMap and Secret. The filename stem
  must equal `applicationName`; CI enforces it. The image tag lives in the
  instance file, not in common, so a rollout can move one instance first —
  the only canary we have without staging. First instance:
  `ultra-relay-arbitrum-ostium`.
- **Build.** Push to main (ignoring docs and `deployments/**`) builds
  `linux/amd64` only and pushes `main-<sha>` to ECR, then creates GitHub
  release `v<run_number>` pinned to the built commit. A manual run on any
  branch pushes `<branch>-<sha>` and cuts no release. No commit is ever
  written back to main. AWS access is OIDC via role `ultra-relay-gha`.
- **Rollout.** A manual `deploy-pr` workflow takes a set of instances and a
  release (or an explicit image tag, for branch builds), verifies the image
  exists in ECR, and opens a PR that changes only `tag:` lines. Merging that
  PR is the deploy: ArgoCD tracks main with automated sync and self-heal.
  **Prod only, no staging** — the service is stateless enough that a bad
  release is undone by a deploy PR back to the previous one.
- **Config.** The same JSON config file used on Render is stored in the
  values file, rendered into a ConfigMap, mounted as a file and loaded via
  `ALTO_CONFIG`. The four secret keys (`executor-private-keys`,
  `utility-private-key`, `rpc-url`, `redis-events-queue-endpoint`) are
  absent from the file; the queue name is plain config. External Secrets
  Operator syncs the secrets from AWS Secrets Manager
  `k8s__ultra-relay_<variant>` (SRE's `k8s__<service>_<variant>` naming; the
  variant is the instance name without its `ultra-relay-` prefix) into a
  Kubernetes Secret whose keys are the upper-cased property names
  (`RPC_URL`, ...); the shared values map each key to the `ALTO_*` env var
  the CLI reads, with the Secret name templated from `applicationName`. yargs
  precedence is
  CLI > env > config file, so env-supplied secrets can never be overridden by
  the file.
- **Exposure.** No public ingress. Each instance gets a Kubernetes Service of
  type LoadBalancer with internal-NLB annotations (port 80 → container 3000).
  The caller (a service in Render's Virginia region) reaches the NLB's private
  IPs over VPC peering using the NLB's own DNS name; we own no DNS zone.
- **Logs** go to stdout as JSON and are collected by the cluster agent into
  Grafana. No BetterStack transport is configured on EKS.
- **Sizing.** One replica; requests 1 CPU / 2 GiB, memory limit 4 GiB, no CPU
  limit; Node heap capped below the memory limit so OOM is a clean crash, not
  a kernel kill. Liveness and readiness probe `/health`; a ServiceMonitor
  scrapes `/metrics` on the same port.
- **Rolling replacement is kept** (new pod starts before the old one stops)
  even though two processes then briefly share the same executor keys and can
  collide on nonces. The team accepts this until the shared Redis mempool
  lands as the next step; that work removes the collision, not this ADR.

## Assumptions

Marked **[verified]** when checked against code or a live source, **[SRE]**
when it depends on infrastructure we could not inspect and must be confirmed
by SRE before first rollout.

1. **[SRE]** ECR lives in the management account `352956043285`, region
   us-west-2, repository `offchain-labs/ultra-relay` — confirmed by SRE, the
   same registry and region every other ZeroDev image uses; the cluster pulls
   cross-region and cross-account exactly like the us-east-1 clusters do. The
   target cluster is `zerodev-prod-ue2-v1` (us-east-2, AWS account
   `518033442333`, the same account as `zerodev-prod-ue1-v1`), added by SRE to
   the ArgoCD config repo for this migration. The repository
   uses immutable tags; the build workflow skips the build when the tag
   already exists, so a re-run can never replace the image behind an existing
   release.
2. **[SRE]** IAM role `arn:aws:iam::352956043285:role/ultra-relay-gha` and
   the ECR repository were created by SRE (values confirmed 2026-09-17). The
   role must trust GitHub OIDC for `repo:zerodevapp/ultra-relay:*` — this
   repository is in the `zerodevapp` org, not `OffchainLabs`, so copying
   another service's trust policy verbatim would fail — and allow ECR push
   plus `ecr:DescribeImages` for the deploy-time existence check. If the
   trust policy is wrong, the first push-to-main build fails at the AWS login
   step; harmless, re-run after the fix.
3. **[SRE]** The `generic-application` chart accepts the value keys we use.
   Partially verified: the `application:` half of the merged values renders
   with the upstream Stakater `application` chart (9.3.1) into a Deployment,
   Service, ConfigMap and ServiceMonitor carrying the expected names, mount,
   probes, rolling-update pin and NLB annotations. Wrapper-only keys
   (`labels`, `configMapChecksum`) and the `external-secret` half could not
   be rendered: the wrapper's source (`OffchainLabs/sre-helm-charts`) and the
   internal chart museum are reachable only over Tailscale. Ask SRE for a
   full `helm template` before the first sync; the values files are **not
   rendered in CI**.
4. **[SRE]** The cluster runs the AWS Load Balancer Controller (internal NLB),
   External Secrets Operator (Secrets Manager sync, with one IRSA role per
   instance, `external-secrets-<instance>-ue2`, allowed to read that
   instance's `k8s__ultra-relay_<variant>` secret), Prometheus Operator
   (ServiceMonitor CRD — the
   chart skips the ServiceMonitor when the CRD is absent, verified in the
   upstream template, so a missing operator costs metrics, not the sync), the
   Reloader
   controller (restarts the pod when the synced Secret changes;
   `configMapChecksum` is implemented by the chart itself and covers
   ConfigMap edits without it), and a log agent shipping stdout to Grafana.
5. **[SRE]** VPC peering exists between Render (Virginia) and the us-east-2
   VPC in both directions: the caller → internal NLB, and the pod → the Redis
   events queue that stays hosted in Render. Cross-region latency is accepted.
   Security groups admit Render's peered CIDR on the NLB listener.
6. **[verified]** ArgoCD registration is one component entry per relay instance
   in `charts/zerodev/config/<cluster>/config.yaml` of
   `OffchainLabs/zerodev-helm-charts` (its app-of-apps chart; an
   ApplicationSet over `config/*/config.yaml`). Each component is a
   multi-source Application: `generic-application` from the internal chart
   museum plus this repo as the `values` ref, exactly how `kms-breakglass`
   points at `breakglass/deployments/`. Adding an instance therefore needs one
   SRE PR; there is no file-generator auto-discovery. Namespace
   `ultra-relay`; Application name `zerodev-prod-ue2-v1-ultra-relay-<instance>`.
   The values stay in this repo by decision; only the entry lives in the
   charts repo (`charts/zerodev/config/zerodev-prod-ue2-v1/config.yaml`).
7. `main` is branch-protected and requires an explicit approval before any
   PR merges (confirmed by the team 2026-09-23; there are no rulesets). Deploy
   PRs are no exception: a person approves each rollout, and that approval is
   the deploy gate.
8. **[verified]** OCL self-hosted runners are org-scoped to `OffchainLabs`, so
   workflows use `ubuntu-latest` while this repo stays in `zerodevapp`.
9. The deploy-PR workflow uses the built-in `GITHUB_TOKEN`, which requires
   the repository setting "Allow GitHub Actions to create and approve pull
   requests". PRs opened with that token get no `pull_request` workflow runs
   at all (GitHub does not create runs for events the built-in token
   triggers), so PR CI does not run on deploy PRs; the check re-runs on main
   after merge, and closing and reopening the PR triggers a pre-merge run —
   accepted because deploy PRs change only `tag:` lines and the image is
   verified in ECR first. Upgrade
   path: the org-owned deploy-PR GitHub App doorway-kms uses, needed only if
   required checks are ever added to main.
10. **[verified]** The CLI registers a config file option and reads `ALTO_*`
    env vars; yargs applies env vars that point to a config file before
    loading it, so `ALTO_CONFIG` works without changing the Docker entrypoint
    (`pnpm start`). All 18 keys in the Render config exist as options.
11. **[verified]** `/health` returns 200 unconditionally and reflects only
    that the process is up, so a failing RPC provider cannot trigger a restart
    loop. `/metrics` is served on the same port (default 3000). SIGTERM is
    handled, so the existing mempool-restoration path applies on pod stop.
12. **[verified]** The image runs as root (Node Alpine default, `pnpm start`
    entrypoint), so `runAsNonRoot` stays false, matching the other services.
    The Dockerfile copies the whole tree and `contracts/` contains git
    submodules, so the checkout must be recursive.
13. **[verified]** Release tags `v<run_number>` (e.g. `v42`) cannot collide
    with the upstream Pimlico `v1.2.x` tags this fork carries. The existing
    npm/changesets release flow and the manual GHCR build workflow are
    unrelated and left untouched (the latter is already broken as a reusable
    workflow; not fixed here).
14. The team accepts that deploying a branch image goes straight to prod with
    the image-existence check and PR review as the only gates.

## Considered options

- **arbitrum-indexer pattern** (patch-bump root `package.json`, commit + tag
  on every push, rewrite the prod values file in the same run). Rejected: a
  bot commit on main per merge, a deploy on every merge with no gate, an
  interaction with the changesets versioning already on main, and a version
  series starting below the upstream `v1.2.5` tag.
- **Staging environment.** Rejected by the team: stateless service, prod
  direct. Per-instance image tags give a canary instead.
- **ArgoCD tracking a branch** for branch deploys. Rejected: it takes prod off
  main and is an SRE-side change per branch. Branch images roll out through
  the same deploy PR with an explicit tag.
- **One env var per option** instead of a mounted config file. Rejected: the
  config file mirrors Render verbatim and keeps the values diff readable.
- **Shared internal gateway** (one NLB, host routing) instead of one NLB per
  instance. Deferred: per-instance is simpler and needs no DNS we control;
  revisit when the fixed NLB fees matter, i.e. many instances.
- **`Recreate` strategy** to avoid the nonce-collision window. Rejected for
  now by the team in favour of no downtime; superseded by the shared Redis
  mempool.

## Consequences

- Merging a `deployments/` change deploys to prod. Branch protection makes
  each such PR, deploy PRs included, wait for an approval.
- Adding an instance = copy a values file, create its Secrets Manager secret,
  merge (+ one SRE line if the ApplicationSet fallback is in use). Workflows
  need no change; the deploy-PR workflow globs the directory.
- Nothing deploys automatically. After merging a code PR someone must run the
  deploy-PR workflow and merge its PR. Prod keeps running whatever tag is in
  the values file, including a branch image, until then.
- Re-running the deploy-PR workflow while its PR is open stops and points at
  the PR instead of force-pushing over manual edits. Re-running a main build
  whose image already exists skips the build and keeps the existing release.
  "Latest" for rollouts means the highest-numbered release, not GitHub's
  latest flag.
- Until the shared Redis mempool ships, each rollout has a window where two
  processes hold the same executor keys.
- **Upgrade triggers:** many instances → shared internal gateway; required
  checks on main → GitHub App token for deploy PRs; chart location shared by
  SRE → `helm template` render check in CI.

See also: `deployments/README.md` for the operator-facing flow.
