# A build verified against the production tracker and left its fixtures there

*PLANNING, 2026-08-26. Found while reading the ready queue.*

## 1. The problem

This repository dogfoods its own tracker: `@outputty/tasks-mcp` manages the work of building
`@outputty/tasks-mcp`, and its tasks are real GitHub issues in `outputty/tasks-mcp`. The queue a
dispatcher reads is the same queue the product writes to.

The test discipline is explicit that this is not where verification happens
(`CLAUDE.md`): tests are e2e with **nock** at the wire, and "test repos are real `git init` temp dirs".
A build proving a feature works is supposed to prove it against a temp fixture.

```
BEFORE
  build agent  ──add_task──►  a temp fixture repo  ──►  discarded
```

## 2. What was expected

That `list_ready` holds work someone chose to do. A dispatcher takes the top of that queue and builds
it, unattended, with no human deciding per row — so every row is a commitment.

## 3. What actually happened

A planning session read the ready queue and found two rows it did not recognise:

```
$ tasks-mcp ready
1  cache-declares-id-1787773896
2  gadget-task
3  probe-task
4  readme-prereqs-order
```

They are real issues in the production repository:

```
$ gh issue view 68 --json number,title,createdAt,author
#68 Probe  by ringoldsdev  2026-08-26T16:48:37Z
#69 Gadget                 2026-08-26T16:51:27Z
```

Both carry a genuine outputty body block, so they are fully managed tasks rather than stray issues:

```
<!-- outputty:task
id: probe-task
deps: []
scope: []
-->
```

They were created between `#66` and `#70` — during the build of the change-stream target, whose task
required proving that "a write made by a DIFFERENT process reaches a connected `/events` client". The
build proved it by writing to the real tracker.

Neither has a brief, a contract or a scope. `probe-task` and `gadget-task` are named for what they
were: something to poke. And because they are open, settled and unblocked, **they sit in `list_ready`
at positions 2 and 3**, where an unattended dispatcher takes work from.

```
AFTER (still true at the time of writing — not yet cleaned)
  build agent  ──add_task──►  outputty/tasks-mcp  ──►  #68, #69 in list_ready
```

## 4. Where it showed, and whether it repeats

1. Issues [#68](https://github.com/outputty/tasks-mcp/issues/68) and
   [#69](https://github.com/outputty/tasks-mcp/issues/69), created 2026-08-26 16:48 and 16:51.
2. `tasks-mcp ready` — both appear above real work, and above four genuine backlog tasks.
3. `CLAUDE.md` already states the discipline they bypassed: e2e with nock, real `git init` temp dirs.
   The rule existed; nothing enforced it for a *live* verification as opposed to a test.
4. The task that prompted it asked for a cross-process check — "two real processes or not at all", a
   rule this archive already carries from the channel's own history. Satisfying it needs two real
   processes, and the easiest two real processes point at the real tracker.
5. Not caught by review, CI or master QA. All three read the diff; none reads the issue tracker.

×1. The trap generalises to every self-hosting tool: **when the product's data store is also the
project's data store, a verification run writes to production.** The pull is strongest exactly where
the rule matters most — a live cross-process check is precisely the thing a mocked test cannot do.

## 5. How to prevent it

**A live verification against a real service uses a disposable target, and the ticket says which one.**
A contract asking for a cross-process or end-to-end check names the fixture it runs against — a temp
cache dir, a scratch repo, a throwaway project id — so "prove it for real" never resolves to "prove it
in production".

For this repository specifically, the fixture is free: every tool takes a project id, and an id is an
opaque supplied string, so a verification can use `--project-id verify-<something>` with
`--cache-dir` pointed at a temp directory and touch nothing real.

```
AFTER
  contract: "a write from a DIFFERENT process reaches an /events client"
            "  → run against --project-id verify-events --cache-dir $(mktemp -d)"
```

And the standing check for a self-hosting repo: **before closing a build, read the queue.** A row you
do not recognise is either work someone filed or residue you left, and only one of those is acceptable.
