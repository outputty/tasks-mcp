# The channel — waking an idle session (roadmap #9, #10)

The server is a **Claude Code channel** as well as a tool provider: it pushes an event into a live
session so an orchestrator can sit idle instead of polling. One kind of event exists, and it is a
**doorbell** — it says which way to look, never a figure to act on, because a channel event arrives on
the reader's next turn and anything numeric in it is stale by then.

## Before / After

Before: a session learned the graph had moved by asking. Nothing could reach it, so the only
alternative to polling was a human.

After: `McpServer` declares the `claude/channel` capability, the **stdio** transport wires a
`Doorbell` to `notifications/claude/channel`, and `list_ready` came back ranked by
`(blocks + 1) x priority weight` so the answer to a ring is ordered. Two hops carry a ring, because a
worker session and an orchestrator never share a process: the in-process `Doorbell` coalesces every
ring in one tick into a single event, and a **spool** file per note crosses processes, claimed by
rename so it is delivered exactly once. The spool keys on `repoSlug` — the primary checkout, resolved
through `git rev-parse --git-common-dir` — so a note raised inside a worktree finds the session
watching from the checkout it was cut from.

`claude/channel/permission` is deliberately **not** declared. Permission relay forwards tool-approval
prompts to whoever holds the other end of the channel, and here that is a spool file, not a human.

## The repair (#10)

v0.14.0 shipped the machinery with two holes that only showed up under real use, when an orchestrator
answered three consecutive doorbells with "nothing changed" while two merged builds sat undispatched.

1. **The wake path was behind an opt-in flag.** `drainEvents` was reachable only from the background
   sync loop, which `--sync-interval` gates and which defaults to off. The plugin documented the
   workaround ("the channel is dark without it") rather than the bug, and this repo's own `.mcp.json`
   carried no flag at all. `watchEvents` now puts an `fs.watch` on the spool the first time a project
   is named, so delivery needs no configuration; the sync drain stays behind it as a backstop for what
   `fs.watch` coalesces or misses.
2. **A closing task announced nothing.** Only `notify` posted to the spool, so a task closing in a
   worktree reached other sessions solely through *their* next reconcile. Every graph mutation now
   announces itself to the other processes — and only to them, since the session that made the change
   already knows. A prose-only edit stays silent: a retitled task is not news.

Two smaller calls fell out of the same investigation. Rings **name the movement**
(`task <id> closed`, `ready now: <ids>`), and a coalesced burst joins the notes instead of replacing
them with `N changes` — the burst is exactly when the reader most needs to know what moved. And `poll`
is guarded, because a junk field on one task throws out of `eligible` and the background loop voids
that promise, which would take the server down over a value someone mistyped in the GitHub UI.

Real observed (2026-08-19): two node processes over the built `dist`, no sync loop and no
`--sync-interval` — notes spooled before the listener started arrived the moment it began watching, a
`close` in one process printed `RING → task rollback closed — re-evaluate` in the other, and a
prose-only retitle printed nothing. `npm run check` green, 91 tests.

## What this does not model

**Dispatch.** `list_ready` answers what the *graph* allows, so a task being worked right now still
appears in it. Tracking what is in flight, and capping how much runs at once, belongs to whatever
starts the work. The reader-side half of the failure went to the same place: the plugin's orchestrator
charter now states that the task graph is the authority on what finished, and that an unfetched local
git ref is not evidence about another session's merge.
