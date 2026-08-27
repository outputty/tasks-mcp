# A clarifying question got a mechanism designed instead of an answer

*Communication that broke down — PLANNING, 2026-08-27.*

## 1. The problem

In a planning dialogue about how tasks-mcp addresses projects, the user asked scoped, factual questions
about the *existing* setup. Each was met with a larger proposed mechanism rather than an answer, and the
design ballooned — a `--repo` flag, then a shared HTTP daemon, then per-connection query addressing —
before the user pulled it back to the simplest shape (a CLI, which already existed).

```
BEFORE: user asks "how does X work?"  ──▶  session DESIGNS a mechanism for X
        (answer arrives only after the mechanism is built and then discarded)
```

## 2. What was expected

The user's questions were narrow and about what exists:

> How would an external mcp connection specify the project?

> show me how the .mcp.json will look like and how the user will set the project_id

They wanted the current mechanism explained, not a new one proposed.

## 3. What actually happened

The first was answered with a shared-daemon + `?project=` design; the second grew a `--repo` flag and two
`.mcp.json` variants. The user course-corrected twice in successive turns —

> Wait, I'm confused about how that works.

> I think that I'm getting very tired of the mcp approach.

— and the eventual answer (CLI-first, no server at all) required *deleting* the mechanism the answers had
been building. The true answer had been available from the start: the CLI already existed and resolved
the project from where it ran.

## 4. Where it showed, and whether it repeats

1. "how would an external mcp connection specify the project?" → answered by designing a daemon plus a
   `?project=` query, not by stating today's per-call `project` argument.
2. Two explicit user course-corrections in consecutive turns (this session's transcript).
3. The direction was abandoned entirely one turn later ("delete MCP"), so the designed mechanism shipped
   nothing.

×1

## 5. How to prevent it

**Answer a clarifying question with the smallest true answer first, grounded in what already exists.
Propose a new mechanism only after the user asks for one — a question is not a feature request.**

```
AFTER: user asks "how does X work?"  ──▶  read the code, state how X works TODAY
       ──▶  the user decides whether a change is even wanted
```
