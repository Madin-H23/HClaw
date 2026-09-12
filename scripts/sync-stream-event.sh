#!/usr/bin/env bash
# Copy canonical shared types to all sub-projects.
# Called by `make build` and `make sync-types`.
# Only copies when content differs, to avoid unnecessary timestamp changes
# that would trigger redundant incremental builds.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Copy file only if content differs
sync_file() {
  local src="$1" target="$2"
  if [ ! -f "$target" ] || ! cmp -s "$src" "$target"; then
    cp "$src" "$target"
  fi
}

# --- StreamEvent types (3 targets) ---
SRC_SE="$ROOT/shared/stream-event.ts"
for target in \
  "$ROOT/container/agent-runner/src/stream-event.types.ts" \
  "$ROOT/src/stream-event.types.ts" \
  "$ROOT/web/src/stream-event.types.ts" \
; do
  sync_file "$SRC_SE" "$target"
done

# --- Image detector (2 targets: backend + agent-runner; not needed by web) ---
SRC_ID="$ROOT/shared/image-detector.ts"
for target in \
  "$ROOT/src/image-detector.ts" \
  "$ROOT/container/agent-runner/src/image-detector.ts" \
; do
  sync_file "$SRC_ID" "$target"
done

# --- Channel registry (3 targets: backend + agent-runner + web) ---
SRC_CR="$ROOT/shared/channel-registry.ts"
for target in \
  "$ROOT/src/channel-registry.ts" \
  "$ROOT/container/agent-runner/src/channel-registry.ts" \
  "$ROOT/web/src/channel-registry.ts" \
; do
  sync_file "$SRC_CR" "$target"
done

# --- Channel prefixes (2 targets: backend + agent-runner; web uses the registry copy) ---
SRC_CP="$ROOT/shared/channel-prefixes.ts"
for target in \
  "$ROOT/src/channel-prefixes.ts" \
  "$ROOT/container/agent-runner/src/channel-prefixes.ts" \
; do
  sync_file "$SRC_CP" "$target"
done
