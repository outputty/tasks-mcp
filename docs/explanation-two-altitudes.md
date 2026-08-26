# About the two altitudes

Why a roadmap row and a unit of work are the same kind of node in one graph, and what that buys.

## The problem with a separate roadmap

Almost every team keeps two things: a list of work, and a shorter list of outcomes the work adds up
to. They usually live apart — the issues in a tracker, the outcomes in a document, a spreadsheet, or a
milestone field. And they immediately start lying to each other. The document says a theme is 60% done
because someone typed 60%. Two of its issues were closed last week and three more were filed. Nobody
updates the number until a meeting forces it.

The second failure is subtler and worse. A queue that only knows about tasks ranks them on task-local
facts: how urgent this one is, how much waits on it. It cannot know that one of them serves the thing
that gates the next release and another serves a theme that was shelved in March. So it hands out work
that is individually reasonable and collectively wrong.

## What tasks-mcp does instead

A **target** is a node in the same graph as the tasks. It carries `type: "target"`, a task points at
it with `target`, and everything else — ids, deps, priority, the GitHub issue behind it — works the
same way it does for a task.

That single decision has three consequences, and they are the whole argument for it.

**Progress stops being authored.** `roadmap` counts the tasks pointing at each target, every time you
ask. There is no field holding 60%, so there is nothing to go stale. `progress.total` is not a promise
of completeness — it is a count of what currently names the row — and that honesty is the point.

**Roadmap questions reuse the machinery.** Because a target is an ordinary node with ordinary `deps`,
`prereqs` on a target answers "what has to ship before this", and `blockers` ranks targets by how much
waits on them. No second engine, no second scheduler.

**The queue ranks at both altitudes at once.** A ready task's score multiplies its own reach, its own
priority, and the standing of the target it serves. An urgent target lifts everything under it; a
target that two other targets wait on lifts its work too, without anyone setting a priority. An
ordinary target — normal priority, blocking nothing — weighs exactly 1, so a stray bug with no
roadmap row is not punished for having none, and a graph that predates targets ranks exactly as it did
before.

One thing deliberately escapes the arithmetic. If a target's own dependencies have not shipped, every
task under it sorts below every task whose roadmap row is clear, however high it scores. That is a
categorical fact about the plan, not a matter of degree, and treating it as one more multiplier would
let a sufficiently urgent task jump a release it cannot be part of.

## Why a target refuses build fields

A target may not carry `scope`, `contract`, `tier`, `qa`, `stage`, or `discovered_from`, and it may
not serve another target.

Those refusals exist because a target that can carry build fields becomes a task in a roadmap hat. It
gets a tier and a QA level, it gets estimated, and eventually somebody builds "the roadmap row" rather
than the work under it. Nothing ever builds a target — it is never offered by `list_ready` — so those
fields would describe work that does not exist. Keeping them off is what stops a roadmap filling with
placeholder parents.

The one-altitude rule (a target cannot serve a target) is the same instinct. Nested themes are how a
roadmap turns into a work breakdown structure, and a work breakdown structure is just the task graph
again, drawn worse.

## Why a target needs a why

`add_target` requires a title _and_ a brief, and the brief is specified as the why — what makes this
worth building, and now — not an implementation spec.

This is the most opinionated rule in the package, and it is enforced rather than suggested. The
justification is that a roadmap is a ranking, and a ranking of rows nobody can justify ranks nothing.
If the why cannot be written, the thing is not a target yet: file it as a task, or leave it unfiled.
The cost is friction on filing a row; the benefit is that every row in the roadmap survived someone
having to say why.

The check runs at creation and on promotion, never on a later edit. A row filed before the rule
existed still has to be closeable.

## Why a target is self-contained

A task's `deps` must stay inside its own target. A dep reaching out is refused on the authoring
surface, with a message telling you to split the target or move the task, and a dep pointing directly
at a target is refused with a message telling you to put that sequencing on the target's own `deps`.

This is what lets a dispatcher take one target and ship its whole set as a single stack. `schedule`
with a `target` argument gives exactly that target's layers, and it seeds "already done" from the
whole graph, so a shipped dependency elsewhere resolves fine. An _unshipped_ dependency outside the
target throws an unmet-dependency error — loudly, at scheduling time, rather than as a build that
stalls forever on work nobody in that stack can do.

`sync` is deliberately tolerant of both rules. It records what GitHub already says, and a repository
that predates the rules should not become unsyncable because of them.

## Where it shows up on GitHub

A task's `target` is stored as the issue's **parent** — the sub-issue edge — and nowhere else. Not in
the body block, not in a label.

Choosing the edge over a field has a cost: it is a separate mutation, capped at 100 sub-issues per
parent, and refused across owners, so the write is best-effort and a failure is logged rather than
fatal. What it buys is that the hierarchy you browse on GitHub and the hierarchy the graph reasons
over are the same object. GitHub draws its own progress bar. Re-parenting an issue in the web UI flows
back on the next sync, because the edge is read, not written twice. And `parent` rides the issue
listing the provider already pages through, so reading membership costs nothing.

## Related

- [MCP tool reference](reference-mcp-tools.md#roadmap) — what `roadmap` and `add_target` actually take
  and return.
- [How to change what the queue offers next](how-to-change-what-the-queue-offers-next.md) — using the
  two altitudes to reorder work.
