#!/usr/bin/env bash
# WorktreeRemove hook — tears down a worktree created by worktree-create.sh.
#
# Pairs with the WorktreeCreate hook: once that hook replaces default git worktree
# creation, Claude Code no longer removes worktrees itself, so this hook must, or
# they orphan under <repo>-worktrees/. Force-remove because node_modules/ and dist/
# are untracked, so git would otherwise refuse to remove a "dirty" worktree.
#
# Contract (verified against claude 2.1.247): stdin is JSON
#   { "hook_event_name": "WorktreeRemove", "worktree_path": <abs path>, ... }
# Exit 0 on success. Never fail the session over cleanup — a best-effort teardown.
set -euo pipefail

log() { printf '[worktree-remove] %s\n' "$*" >&2; }

input=$(cat)
wt=$(printf '%s' "$input" | jq -r '.worktree_path // empty')
[ -n "$wt" ] || { log "no worktree_path in hook input; nothing to do"; exit 0; }

# The main worktree is the first entry of `git worktree list`; run removal from it
# so git never treats the target as the current tree. Fall back to the input cwd.
repo=$(git -C "$wt" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}' || true)
[ -n "$repo" ] || repo=$(printf '%s' "$input" | jq -r '.cwd // empty')

log "removing worktree $wt"
if [ -n "$repo" ] && [ -d "$repo" ]; then
  git -C "$repo" worktree remove --force "$wt" 2>/dev/null \
    || { rm -rf "$wt"; git -C "$repo" worktree prune 2>/dev/null || true; }
else
  rm -rf "$wt"
fi
log "done"
