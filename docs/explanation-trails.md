# About trails

Why a task's decision record is its GitHub issue comment thread, and what that choice costs.

![The trail flow: append_trail checks the task has an issue and posts a comment via addComment; get_trail reads the issue's comment thread back, oldest first](trails.svg)

## What a trail is for

A build makes decisions that are not visible in the diff. It picks streaming over buffering because
the largest export is 400,000 rows. It abandons an approach after finding out why it cannot work. Six
weeks later somebody asks why the code is shaped like that, and the answer is either in a person's
head or nowhere.

A trail is the answer being written down at the moment it is made. `append_trail` records one note —
optionally tagged `decision`, `action`, or `note`, optionally carrying a link to where it landed — and
`get_trail` reads the whole thing back, oldest first.

## Why the issue's comment thread

The alternative would have been a field on the task: an array of entries in the record, stored in the
hidden block and synced like everything else. That is simpler to implement and it would have been
wrong.

An issue already has a discussion thread. It is where a colleague leaves "have you considered…", where
CI posts, where the person who reported the bug follows up. If trails lived in a field, there would be
two conversations about one task — one visible on GitHub, one visible only to the tool — and neither
would be complete.

Putting the trail on the thread makes **every comment an entry**. A note an agent wrote and a comment
a person typed in the web UI come back from `get_trail` in one list, in order. That is not a side
effect of the implementation; it is the reason for it. The decisions behind a task and the discussion
about it are the same conversation, and splitting them would make both less useful.

The second benefit is one nobody has to opt into: the trail renders as an ordinary GitHub thread. No
viewer, no export, no tool required to read it. It survives this package being replaced.

## How the tags survive

`kind` and `link` are structure the thread has no place for, so they ride a hidden HTML-comment marker
at the top of the comment body. GitHub does not render an HTML comment, so the comment still reads as
plain text; the marker is parsed back off on read.

A comment a person wrote has no marker, and comes back as a bare `note` with the `author` and `at`
that GitHub supplies. That asymmetry is correct — a human comment genuinely has no `kind` — and it is
why `kind` is optional in the entry shape rather than defaulted.

## What it costs

**A trail needs an issue.** `append_trail` on a task GitHub has never seen fails with an instruction to
sync first, and a project whose stack has no GitHub-backed layer cannot have trails at all — the file
cache has no comment surface. The service routes trail calls to the deepest layer that implements
them, and if none does, it says so rather than pretending.

**A trail read is a network call.** Unlike every other read in the package, `get_trail` is not answered
from the local cache; it pages the issue's comments over GraphQL. Caching them would mean deciding
when a cached thread is stale, and a thread that people also write to has no good answer to that.

**Nothing about the trail is local.** It is not in the cache file, so it does not survive the
repository being deleted from GitHub, and it does not work offline. The judgement here is that a
decision record which only exists on one laptop is not a record.

## The heartbeat it doubles as

`append_trail` also refreshes the claim on the task, if it holds one. That is not a second feature
bolted on; it is the reason claims need no explicit heartbeat call at all. A build already writes a
note per layer, so the liveness signal is a by-product of recording decisions, and a worker that has
stopped recording is unambiguous.

A note on a task nobody claimed never creates a claim. Commenting on an open issue says nothing about
anyone building it.

See [About claims](explanation-claims.md).

## Related

- [Task record reference](reference-task-record.md#trail-entry) — the entry's exact fields.
- [MCP tool reference](reference-mcp-tools.md#append_trail) — arguments and refusals.
