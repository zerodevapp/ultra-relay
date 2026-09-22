#!/usr/bin/env bash
# Rewrite the image tag of one or more relay instances.
#
#   scripts/deployments/bump-tag.sh <image-tag> <all|name[,name...]>
#
# Rewrites the single "tag:" line in each selected
# $DEPLOYMENTS_DIR/<instance>.values.yaml (default dir: deployments) and prints
# one markdown table row per file:  | `<file>` | `<old>` | `<new>` |
# common.values.yaml is never touched. Exit 1 on an invalid image tag, an
# invalid instance name, an unknown instance, or a file that does not have
# exactly one "tag:" line (check.py enforces the same, and additionally that the
# line is application.deployment.image.tag).
set -euo pipefail

IMAGE_TAG="${1:?usage: bump-tag.sh <image-tag> <all|name[,name...]>}"
# Docker tag grammar: [A-Za-z0-9_] then up to 127 of [A-Za-z0-9._-]. This also
# keeps "#", "&" and quotes out of the sed replacement below.
[[ "$IMAGE_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$ ]] || { echo "::error::invalid image tag '$IMAGE_TAG'" >&2; exit 1; }
INSTANCES="${2:?usage: bump-tag.sh <image-tag> <all|name[,name...]>}"
DIR="${DEPLOYMENTS_DIR:-deployments}"

files=()
if [ "$INSTANCES" = "all" ]; then
  for f in "$DIR"/*.values.yaml; do
    [ "$(basename "$f")" = "common.values.yaml" ] && continue
    files+=("$f")
  done
else
  IFS=',' read -r -a names <<< "$INSTANCES"
  for n in "${names[@]}"; do
    n="${n// /}"
    [ -n "$n" ] || continue
    [[ "$n" =~ ^ultra-relay-[a-z0-9]+(-[a-z0-9]+)*$ ]] || { echo "::error::invalid instance name '$n'" >&2; exit 1; }
    f="$DIR/$n.values.yaml"
    [ -f "$f" ] || { echo "::error::unknown instance '$n' (no $f)" >&2; exit 1; }
    files+=("$f")
  done
fi
[ "${#files[@]}" -gt 0 ] || { echo "::error::no instance files selected" >&2; exit 1; }

# Horizontal whitespace only ([[:blank:]]), matching check.py's regex.
for f in "${files[@]}"; do
  count=$(grep -cE '^[[:blank:]]+tag:' "$f" || true)
  [ "$count" = "1" ] || { echo "::error::$f must have exactly one 'tag:' line, found $count" >&2; exit 1; }
  old=$(grep -E '^[[:blank:]]+tag:' "$f" | sed -E 's/^[[:blank:]]+tag:[[:blank:]]*//; s/[[:blank:]]+#.*$//; s/["'"'"']//g')
  # Portable in-place edit (no `sed -i`, whose syntax differs on macOS).
  # Quoted so YAML keeps numeric/boolean-looking tags (123, true) as strings.
  sed -E "s#^([[:blank:]]+tag:).*\$#\\1 \"${IMAGE_TAG}\"#" "$f" > "$f.tmp"
  mv "$f.tmp" "$f"
  echo "| \`$f\` | \`${old:-?}\` | \`${IMAGE_TAG}\` |"
done
