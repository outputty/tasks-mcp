#!/usr/bin/env bash
# WorktreeCreate hook — replaces Claude Code's default git worktree creation.
#
# Why this exists: .mcp.json runs the project's OWN build as its tasks MCP server
# (`node dist/cli.js`). dist/ and node_modules/ are gitignored, so a freshly-cut
# worktree has neither, the server process exits, and every dispatched build halts
# with CONNECTION_CLOSED before its first `roadmap` call. This hook installs deps
# and builds dist/ so the server can start when the worktree session launches.
# The only hook that runs BEFORE the session (and thus before MCP servers connect)
# is WorktreeCreate; SessionStart/Setup fire after MCP has already tried to connect.
#
# Contract (verified against claude 2.1.247): stdin is JSON
#   { "hook_event_name": "WorktreeCreate", "name": <slug>, "cwd": <session cwd>, ... }
# The hook MUST create the worktree directory itself and print its absolute,
# dot-free path as the LAST line of stdout. All diagnostics go to stderr. Any
# non-zero exit fails worktree creation (loud, not silent).
#
# baseRef: head — the worktree is cut detached at the dispatcher's HEAD; the
# builder cuts its own feature branch inside it.
set -euo pipefail

log() { printf '[worktree-create] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

command -v git >/dev/null || die "git not on PATH"
command -v jq  >/dev/null || die "jq not on PATH"
command -v npm >/dev/null || die "npm not on PATH"

input=$(cat)
name=$(printf '%s' "$input" | jq -r '.name // empty')
[ -n "$name" ] || die "no worktree name in hook input"

# Repo root: prefer CLAUDE_PROJECT_DIR (set by the harness), fall back to the
# input cwd resolved to its git toplevel.
repo="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$repo" ]; then
  cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
  [ -n "$cwd" ] || die "no CLAUDE_PROJECT_DIR and no cwd in hook input"
  repo=$(git -C "$cwd" rev-parse --show-toplevel)
fi
repo=$(cd "$repo" && pwd -P)

# Dot-free slug: the harness rejects a worktree path containing dot segments.
slug=$(printf '%s' "$name" | tr -c 'A-Za-z0-9_-' '-')
[ -n "$slug" ] || die "worktree name '$name' sanitises to empty"
worktrees="${repo}-worktrees"
path="${worktrees}/${slug}"

log "creating '$slug' at $path (detached at HEAD of $repo)"
mkdir -p "$worktrees"
# Idempotent: clear a stale worktree of the same name before recreating.
if [ -e "$path" ]; then
  log "path exists; removing prior worktree"
  git -C "$repo" worktree remove --force "$path" 2>/dev/null || rm -rf "$path"
  git -C "$repo" worktree prune 2>/dev/null || true
fi
git -C "$repo" worktree add --detach "$path" HEAD 1>&2

log "installing dependencies (npm ci) — this is the per-dispatch cost"
( cd "$path" && npm ci ) 1>&2
log "building dist (npm run build)"
( cd "$path" && npm run build ) 1>&2

log "ready: $path"
printf '%s\n' "$path"
