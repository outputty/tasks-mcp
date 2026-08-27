# A requirement written as a constraint is not a done-condition, and does not get built

*PLANNING, 2026-08-27. Target [#61](https://github.com/outputty/tasks-mcp/issues/61), the TUI console.*

## 1. The problem

A task issue in this flow has two sections that both read like requirements, and only one of them is
checked.

- **Definition of done** — numbered cases, each a check a stranger can run. This is what master QA
  verifies and what a build works towards.
- **Constraints to respect** — facts that shape *how* the build is done, each with its consequence.

The `issue-authoring` skill is explicit about the split: the definition of done is "**numbered cases**,
each a check that a builder can run", while constraints are "a fact that shapes the build". Nothing says
a constraint is optional — but nothing checks one either.

```
BEFORE
  contract
    ├── Definition of done   → master QA checks each numbered case
    └── Constraints          → read, respected where convenient, verified by nobody
```

## 2. What was expected

That a requirement stated plainly in a contract gets built, wherever in the contract it appears. The
planning session that wrote the console's task graph put two behaviours into constraints rather than
done-conditions, believing they were thereby specified.

The target program in `architecture.md` promised both outright:

> Live updates come from `GET /events`, one SSE connection per tracker.

and showed a queue with real ages for live builds:

```
│ outputty/laygo       run-phases-refactor         in progress   14m     │
```

## 3. What actually happened

Neither shipped, and the builds said so plainly.

**Live updates.** `tui-trackers`'s contract carried this, under *Constraints to respect*:

> One SSE connection per tracker, and every one is closed on quit.

No numbered case required a subscription to exist. The build's own follow-up ticket named the mechanism
exactly:

> the `tui-trackers` constraint anticipates "one SSE connection per tracker, closed on quit", but no
> build-layer contract case required it, so it was deferred to keep the trackers layer tractable

**The age column.** This one is subtler, and worse. `tui-prototype`'s done-condition case 2 *did* require
it — "Rows show project, task, state and age" — so the column was built and passes. But nothing required
the **data behind it**, and the MCP surface only exposed claim timing for *stale* claims. So the console
shipped a conforming AGE column that displays `—` for every live build, which is the one case it exists
for. The contract was satisfied and the feature was not.

Both came back as follow-up tickets filed by the builds that noticed — which is the flow working, at the
cost of a whole extra planning session and two more layers.

## 4. Where it showed, and whether it repeats

1. `tui-trackers-1787773896`, *Constraints to respect* — "one SSE connection per tracker, closed on quit".
   Never built; refiled as `tui-live-events-1787780124`.
2. `tui-prototype-1787773896`, done-condition case 2 — "Rows show project, task, state and age". Built,
   passing, and blank in practice; refiled as `expose-active-claim-age-1787777373`.
3. `.claude/architecture.md`'s target program promised both, in prose and in a mockup. A target program
   is not a contract and nothing verifies it, so neither promise had a checker anywhere.
4. Master QA passed the whole target. It reads the diff against the done-conditions, and both gaps were
   invisible to that reading — one lived in a constraint, the other passed its case.

×1 as a written lesson, but **twice in one target**, by two different routes into the same hole: a
requirement no numbered case can fail.

## 5. How to prevent it

**Anything that must exist goes in the definition of done as a numbered case. Constraints say how, never
what.** When drafting a contract, read each constraint and ask "if the build ignores this, does a case
fail?" If not, it is not a requirement — promote it or accept it will not be built.

```
AFTER
  Definition of done
    N. One /events subscription per connected tracker; a change made by a
       DIFFERENT process redraws the queue with no user input.
  Constraints to respect
    - No new dependency for SSE: EventSource is absent on Node 26.5.0 and
      fetch + a ReadableStream reader is verified to work.
```

**And a case must be falsifiable by the behaviour, not by the artefact.** "Rows show an age" is satisfied
by a column of dashes. "A task claimed seconds ago shows a real age, not `—`" is not. Where a done-
condition names a UI element, name the value it must display in the case the feature exists for —
otherwise the check passes on an empty shell.

The same test applies to a target program: it is prose, verified by nothing, so every promise in it needs
a numbered case under some task or it is decoration.
