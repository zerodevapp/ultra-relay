#!/usr/bin/env python3
"""Validate deployments/*.values.yaml.

One file per relay instance (see CONTEXT.md "Relay instance" and
deployments/README.md). Rules enforced:

  1. The filename stem is a valid instance name and equals
     application.applicationName.
  2. application.deployment.image.tag is a non-empty string, "tag" is the
     only mapping key with that name anywhere in the document, and the file
     has exactly one "tag:" line whose value equals that image tag;
     common.values.yaml has no "tag:" line. bump-tag.sh rewrites that single
     line, so this is its contract.
  3. application.configMap.files.config["config.json"] parses as JSON and
     contains none of the secret keys (those come from Secrets Manager).
  4. external-secret.externalSecrets["<instance>-secrets"].data holds exactly
     the five required (secretKey, property) mappings, no duplicate
     secretKey, each with remoteRef.key == "ultra-relay/<instance>".
  5. application.deployment.volumes.config.configMap.name is
     "<instance>-config" — a copied file that keeps another instance's name
     would mount that instance's config.json.
  6. externalSecrets defines no entry other than "<instance>-secrets" — a
     leftover block from a copied file would make two ArgoCD apps fight over
     one ExternalSecret.
  7. The file parses as YAML with no duplicate mapping keys (reported as one
     finding, not a traceback).

Usage: python3 scripts/deployments/check.py [dir]   (default: deployments)
Exit 0 when everything passes, 1 with one finding per line otherwise.
"""
import json
import re
import sys
from pathlib import Path

import yaml

NAME_RE = re.compile(r"^ultra-relay-[a-z0-9]+(-[a-z0-9]+)*$")
# Horizontal whitespace only: "\s" would swallow the newline after an empty
# "tag:" and disagree with the line-based grep in bump-tag.sh. Group 1 is the
# line's value without a trailing comment.
TAG_LINE_RE = re.compile(r"^[ \t]+tag:[ \t]*([^#\n]*?)[ \t]*(?:#[^\n]*)?$", re.M)
# Kubernetes Secret key (upper-cased property name) -> Secrets Manager property.
# common.values.yaml maps each Secret key to the ALTO_* env var the CLI reads.
REQUIRED_MAPPINGS = {
    "EXECUTOR_PRIVATE_KEYS": "executor-private-keys",
    "UTILITY_PRIVATE_KEY": "utility-private-key",
    "RPC_URL": "rpc-url",
    "REDIS_EVENTS_QUEUE_ENDPOINT": "redis-events-queue-endpoint",
    "REDIS_EVENTS_QUEUE_NAME": "redis-events-queue-name",
}
SECRET_KEYS = set(REQUIRED_MAPPINGS.values())
SUFFIX = ".values.yaml"


class StrictLoader(yaml.SafeLoader):
    """SafeLoader that rejects duplicate mapping keys instead of keeping the last.

    yaml.safe_load silently lets a second `image:` block win, which would hide
    the `tag:` line bump-tag.sh rewrites.
    """

    def construct_mapping(self, node, deep=False):
        seen = set()
        for key_node, _ in node.value:
            key = self.construct_object(key_node, deep=True)
            if key in seen:
                raise yaml.constructor.ConstructorError(
                    None, None, f"duplicate mapping key {key!r}", key_node.start_mark
                )
            seen.add(key)
        return super().construct_mapping(node, deep)


def load_yaml(text: str):
    return yaml.load(text, Loader=StrictLoader)


def dig(node, *path):
    for key in path:
        if not isinstance(node, dict) or key not in node:
            return None
        node = node[key]
    return node


def count_keys(node, name: str) -> int:
    """Number of mapping keys called `name` anywhere in the parsed document."""
    if isinstance(node, dict):
        return sum((1 if k == name else 0) + count_keys(v, name) for k, v in node.items())
    if isinstance(node, list):
        return sum(count_keys(item, name) for item in node)
    return 0


def check_common(path: Path) -> list[str]:
    text = path.read_text()
    try:
        load_yaml(text)
    except yaml.YAMLError as exc:
        return [f"{path}: invalid YAML: {exc}"]
    if TAG_LINE_RE.search(text):
        return [f"{path}: image tags live in instance files, not common"]
    return []


def check_instance(path: Path) -> list[str]:
    errors = []
    name = path.name[: -len(SUFFIX)]
    text = path.read_text()
    try:
        doc = load_yaml(text) or {}
    except yaml.YAMLError as exc:
        return [f"{path}: invalid YAML: {exc}"]

    if not NAME_RE.match(name):
        errors.append(f"{path}: '{name}' must match {NAME_RE.pattern}")
    app_name = dig(doc, "application", "applicationName")
    if app_name != name:
        errors.append(
            f"{path}: application.applicationName is {app_name!r}, expected {name!r}"
        )

    tag = dig(doc, "application", "deployment", "image", "tag")
    if not isinstance(tag, str) or not tag.strip():
        errors.append(
            f"{path}: application.deployment.image.tag must be a non-empty string, got {tag!r}"
        )
    tag_keys = count_keys(doc, "tag")
    if tag_keys != 1:
        errors.append(
            f"{path}: 'tag' must appear exactly once (application.deployment.image.tag), found {tag_keys} keys"
        )
    tag_lines = TAG_LINE_RE.findall(text)
    if len(tag_lines) != 1:
        errors.append(
            f"{path}: expected exactly one 'tag:' line (the image tag), found {len(tag_lines)}"
        )
    elif isinstance(tag, str) and tag_lines[0].strip("\"'") != tag:
        errors.append(
            f"{path}: the 'tag:' line reads {tag_lines[0]!r} but application.deployment.image.tag is {tag!r}"
        )

    volume_cm = dig(doc, "application", "deployment", "volumes", "config", "configMap", "name")
    if volume_cm != f"{name}-config":
        errors.append(
            f"{path}: application.deployment.volumes.config.configMap.name must be "
            f"'{name}-config', got {volume_cm!r}"
        )

    config = dig(doc, "application", "configMap", "files", "config", "config.json")
    if config is None:
        errors.append(f"{path}: missing application.configMap.files.config.config.json")
    else:
        try:
            parsed = json.loads(config)
        except json.JSONDecodeError as exc:
            errors.append(f"{path}: config.json is not valid JSON: {exc}")
        else:
            leaked = sorted(SECRET_KEYS & set(parsed))
            if leaked:
                errors.append(
                    f"{path}: secret keys must not be in config.json: {', '.join(leaked)}"
                )

    secret_name = f"{name}-secrets"
    ext = dig(doc, "external-secret", "externalSecrets") or {}
    if secret_name not in ext:
        errors.append(f"{path}: external-secret.externalSecrets must define {secret_name!r}")
    else:
        expected_key = f"ultra-relay/{name}"
        found: dict[str, str] = {}
        for entry in (ext[secret_name] or {}).get("data") or []:
            secret_key = entry.get("secretKey") if isinstance(entry, dict) else None
            if str(secret_key) in found:
                errors.append(f"{path}: duplicate secret mapping {secret_key}")
            found[str(secret_key)] = str(dig(entry, "remoteRef", "property"))
            remote_key = dig(entry, "remoteRef", "key")
            if remote_key != expected_key:
                errors.append(
                    f"{path}: {secret_key}: remoteRef.key {remote_key!r} must be {expected_key!r}"
                )
        for secret_key, prop in REQUIRED_MAPPINGS.items():
            if secret_key not in found:
                errors.append(f"{path}: missing secret mapping {secret_key} -> {prop}")
            elif found[secret_key] != prop:
                errors.append(
                    f"{path}: {secret_key} must map to property {prop!r}, got {found[secret_key]!r}"
                )
        for secret_key in sorted(set(found) - set(REQUIRED_MAPPINGS)):
            errors.append(f"{path}: unexpected secret mapping {secret_key}")

    extras = sorted(set(ext) - {secret_name})
    if extras:
        errors.append(
            f"{path}: unexpected externalSecrets entries {', '.join(extras)} "
            f"(only {secret_name!r} belongs to this instance)"
        )
    return errors


def main(argv: list[str]) -> int:
    directory = Path(argv[1] if len(argv) > 1 else "deployments")
    files = sorted(directory.glob(f"*{SUFFIX}"))
    if not files:
        print(f"no *{SUFFIX} files in {directory}")
        return 1
    errors: list[str] = []
    for path in files:
        if path.name == f"common{SUFFIX}":
            errors += check_common(path)
        else:
            errors += check_instance(path)
    for line in errors:
        print(line)
    print(f"checked {len(files)} file(s): {'FAIL' if errors else 'OK'}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
