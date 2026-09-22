#!/usr/bin/env bash
# Tests for scripts/deployments/check.py and bump-tag.sh.
# Run from anywhere: scripts/deployments/test.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -r "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
expect_fail() { # expect_fail <message> <cmd...>
  local msg="$1"; shift
  if "$@" >/dev/null 2>&1; then fail "$msg"; fi
}

# data_block <remoteRefKey>: the required secret mappings (must match
# REQUIRED_MAPPINGS in check.py), YAML indented for the
# externalSecrets.<name>.data list.
data_block() {
  local key="$1" pair
  for pair in EXECUTOR_PRIVATE_KEYS:executor-private-keys \
              UTILITY_PRIVATE_KEY:utility-private-key \
              RPC_URL:rpc-url \
              REDIS_EVENTS_QUEUE_ENDPOINT:redis-events-queue-endpoint \
              REDIS_EVENTS_QUEUE_NAME:redis-events-queue-name; do
    printf '        - secretKey: %s\n          remoteRef:\n            key: %s\n            property: %s\n' \
      "${pair%%:*}" "$key" "${pair#*:}"
  done
}

# fixture <instance> <applicationName> <remoteRefKey> [extra config.json member] [data block]
fixture() {
  local extra="${4:-}"
  local data="${5:-$(data_block "$3")}"
  cat > "$TMP/$1.values.yaml" <<FIXTURE
application:
  applicationName: $2
  deployment:
    image:
      tag: main-1111111
    volumes:
      config:
        configMap:
          name: $1-config
  configMap:
    files:
      config:
        config.json: |
          {"entrypoints": "0xabc", "json": true$extra}
external-secret:
  externalSecrets:
    $1-secrets:
      data:
$data
FIXTURE
}

cat > "$TMP/common.values.yaml" <<FIXTURE
application:
  deployment:
    image:
      repository: example/ultra-relay
FIXTURE

OSTIUM=ultra-relay-arbitrum-ostium
BASE=ultra-relay-base
# Secrets Manager keys follow SRE's k8s__<service>_<variant> convention, where
# the variant is the instance name without its ultra-relay- prefix.
OSTIUM_KEY=k8s__ultra-relay_arbitrum-ostium
BASE_KEY=k8s__ultra-relay_base

# 1. A valid layout passes.
fixture "$OSTIUM" "$OSTIUM" "$OSTIUM_KEY"
python3 "$HERE/check.py" "$TMP" >/dev/null || fail "valid fixtures should pass"

# 2. applicationName must equal the filename stem.
fixture "$BASE" ultra-relay-wrong "$BASE_KEY"
expect_fail "applicationName mismatch should fail" python3 "$HERE/check.py" "$TMP"

# 3. A secret key inside config.json fails.
fixture "$BASE" "$BASE" "$BASE_KEY" ', "rpc-url": "https://x"'
expect_fail "secret key in config.json should fail" python3 "$HERE/check.py" "$TMP"

# 4. remoteRef.key must be k8s__ultra-relay_<variant> for this instance.
fixture "$BASE" "$BASE" "$OSTIUM_KEY"
expect_fail "wrong remoteRef.key should fail" python3 "$HERE/check.py" "$TMP"

# 5. Every REQUIRED_MAPPINGS entry is required (here only three of five).
fixture "$BASE" "$BASE" "$BASE_KEY" "" "$(data_block "$BASE_KEY" | head -n 12)"
expect_fail "missing secret mapping should fail" python3 "$HERE/check.py" "$TMP"

# 6. A wrong property name fails.
fixture "$BASE" "$BASE" "$BASE_KEY" "" "$(data_block "$BASE_KEY" | sed 's/property: rpc-url/property: rpc_url/')"
expect_fail "wrong secret property should fail" python3 "$HERE/check.py" "$TMP"

# 7. An empty image tag fails in check.py.
fixture "$BASE" "$BASE" "$BASE_KEY"
sed -E 's/^([[:blank:]]+tag:).*$/\1/' "$TMP/$BASE.values.yaml" > "$TMP/t.tmp" && mv "$TMP/t.tmp" "$TMP/$BASE.values.yaml"
expect_fail "empty tag should fail" python3 "$HERE/check.py" "$TMP"

# 8. A tag: line that is not application.deployment.image.tag fails.
cat > "$TMP/$BASE.values.yaml" <<FIXTURE
application:
  applicationName: $BASE
  labels:
    tag: main-1111111
  deployment:
    image:
      repository: example/ultra-relay
    volumes:
      config:
        configMap:
          name: $BASE-config
  configMap:
    files:
      config:
        config.json: |
          {"json": true}
external-secret:
  externalSecrets:
    $BASE-secrets:
      data:
$(data_block "$BASE_KEY")
FIXTURE
expect_fail "tag outside deployment.image should fail" python3 "$HERE/check.py" "$TMP"

# 9. A tag in common.values.yaml fails.
fixture "$BASE" "$BASE" "$BASE_KEY"
printf '      tag: main-0000000\n' >> "$TMP/common.values.yaml"
expect_fail "tag in common should fail" python3 "$HERE/check.py" "$TMP"
sed '$d' "$TMP/common.values.yaml" > "$TMP/c.tmp" && mv "$TMP/c.tmp" "$TMP/common.values.yaml"
python3 "$HERE/check.py" "$TMP" >/dev/null || fail "fixtures should pass again after restoring common"

# 10. bump-tag rewrites only the selected instance and prints a table row.
row=$(DEPLOYMENTS_DIR="$TMP" "$HERE/bump-tag.sh" main-2222222 "$BASE")
grep -qE 'tag: "?main-2222222"?' "$TMP/$BASE.values.yaml" || fail "tag not rewritten"
grep -q 'tag: main-1111111' "$TMP/$OSTIUM.values.yaml" || fail "unselected instance must be untouched"
[[ "$row" == *'`main-1111111`'*'`main-2222222`'* ]] || fail "table row must show old and new tag, got: $row"

# 11. "all" updates every instance and never touches common.
DEPLOYMENTS_DIR="$TMP" "$HERE/bump-tag.sh" main-3333333 all >/dev/null
grep -qE 'tag: "?main-3333333"?' "$TMP/$OSTIUM.values.yaml" || fail "all must update every instance"
grep -qE 'tag: "?main-3333333"?' "$TMP/$BASE.values.yaml" || fail "all must update every instance"
if grep -q 'tag:' "$TMP/common.values.yaml"; then fail "common must never receive a tag"; fi

# 12. Unknown instance fails.
expect_fail "unknown instance should fail" env DEPLOYMENTS_DIR="$TMP" "$HERE/bump-tag.sh" main-4444444 ultra-relay-nope

# 13. Comma-separated list with spaces is accepted.
DEPLOYMENTS_DIR="$TMP" "$HERE/bump-tag.sh" main-5555555 "$BASE, $OSTIUM" >/dev/null
grep -qE 'tag: "?main-5555555"?' "$TMP/$BASE.values.yaml" || fail "list must update each named instance"

# 14. bump-tag also handles an empty tag: line (old value printed as ?).
sed -E 's/^([[:blank:]]+tag:).*$/\1/' "$TMP/$BASE.values.yaml" > "$TMP/t.tmp" && mv "$TMP/t.tmp" "$TMP/$BASE.values.yaml"
row=$(DEPLOYMENTS_DIR="$TMP" "$HERE/bump-tag.sh" main-6666666 "$BASE")
grep -qE 'tag: "?main-6666666"?' "$TMP/$BASE.values.yaml" || fail "empty tag must be rewritten"
[[ "$row" == *'`?`'*'`main-6666666`'* ]] || fail "empty old tag must print as ?, got: $row"

# 15. A duplicated secretKey fails even when one copy is correct.
fixture "$BASE" "$BASE" "$BASE_KEY" "" "$(data_block "$BASE_KEY"; data_block "$BASE_KEY" | head -n 4)"
expect_fail "duplicate secret mapping should fail" python3 "$HERE/check.py" "$TMP"

# 16. An inline image tag plus a second key named tag (a label) fails: the one
#     tag: line would not be the image tag and the bumper would edit the label.
cat > "$TMP/$BASE.values.yaml" <<FIXTURE
application:
  applicationName: $BASE
  labels:
    tag: previous
  deployment:
    image: {tag: main-1111111}
    volumes:
      config:
        configMap:
          name: $BASE-config
  configMap:
    files:
      config:
        config.json: |
          {"json": true}
external-secret:
  externalSecrets:
    $BASE-secrets:
      data:
$(data_block "$BASE_KEY")
FIXTURE
expect_fail "second key named tag should fail" python3 "$HERE/check.py" "$TMP"
rm "$TMP/$BASE.values.yaml"

# 17. A copied file that keeps another instance's ConfigMap name fails.
fixture "$BASE" "$BASE" "$BASE_KEY"
sed "s/name: $BASE-config/name: $OSTIUM-config/" "$TMP/$BASE.values.yaml" > "$TMP/t.tmp" && mv "$TMP/t.tmp" "$TMP/$BASE.values.yaml"
expect_fail "stale ConfigMap volume name should fail" python3 "$HERE/check.py" "$TMP"

# 18. A leftover externalSecrets block from another instance fails.
fixture "$BASE" "$BASE" "$BASE_KEY"
printf '    %s-secrets:\n      data: []\n' "$OSTIUM" >> "$TMP/$BASE.values.yaml"
expect_fail "extra externalSecrets entry should fail" python3 "$HERE/check.py" "$TMP"
rm "$TMP/$BASE.values.yaml"

# 19. bump-tag rejects an instance name that is not a relay instance name.
expect_fail "invalid instance name should fail" env DEPLOYMENTS_DIR="$TMP" "$HERE/bump-tag.sh" main-7777777 "../escape"

# 20. A numeric-looking tag is written as a YAML string and still validates.
fixture "$BASE" "$BASE" "$BASE_KEY"
DEPLOYMENTS_DIR="$TMP" "$HERE/bump-tag.sh" 123 "$BASE" >/dev/null
grep -q 'tag: "123"' "$TMP/$BASE.values.yaml" || fail "numeric tag must be quoted"
python3 "$HERE/check.py" "$TMP" >/dev/null || fail "quoted numeric tag must validate"

# 21. bump-tag rejects an image tag outside the Docker tag grammar.
expect_fail "invalid image tag should fail" env DEPLOYMENTS_DIR="$TMP" "$HERE/bump-tag.sh" 'bad#tag' "$BASE"

# 22. A duplicate top-level mapping key is a finding, not a traceback.
fixture "$BASE" "$BASE" "$BASE_KEY"
printf 'application:\n  deployment:\n    image: {tag: main-0000000}\n' >> "$TMP/$BASE.values.yaml"
out=$(python3 "$HERE/check.py" "$TMP" 2>&1 || true)
[[ "$out" == *"duplicate mapping key"* ]] || fail "duplicate key must be reported, got: $out"
rm "$TMP/$BASE.values.yaml"

echo "ok: deployments scripts"
