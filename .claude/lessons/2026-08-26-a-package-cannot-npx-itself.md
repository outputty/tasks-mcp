# A package cannot npx itself, so the repo that publishes a tool could not run it

*PLANNING, 2026-08-26. Fixed in `c31dcde`.*

## 1. The problem

`@outputty/tasks-mcp` is published to npm and registered with MCP clients through a `.mcp.json` that
launches it on demand — the documented, install-free path:

```json
{ "mcpServers": { "tasks": { "command": "npx", "args": ["-y", "@outputty/tasks-mcp"] } } }
```

This repository dogfoods its own tracker, so `0fc9a58` ("chore: wire outputty into this repo") added
that same file here:

```json
{ "mcpServers": { "tasks": {
  "command": "npx", "args": ["-y", "@outputty/tasks-mcp", "--sync-interval", "60"] } } }
```

```
BEFORE
  session starts in /path/to/tasks-mcp
      -> npx -y @outputty/tasks-mcp
      -> ???
```

## 2. What was expected

That the line which works for every user works here too. It is the same package, the same registry, the
same command.

## 3. What actually happened

Every session in this repository started with no `mcp__tasks__*` tools at all.

```
$ claude mcp list
plugin:outputty:tasks: npx -y @outputty/tasks-mcp - ✘ Failed to connect — CONNECTION_CLOSED
tasks: npx -y @outputty/tasks-mcp --sync-interval 60 - ✘ Failed to connect — CONNECTION_CLOSED
```

The cause is `npx`'s resolution order, and it depends entirely on the working directory:

```
$ cd /path/to/tasks-mcp && npx -y @outputty/tasks-mcp --version
sh: tasks-mcp: command not found

$ cd /tmp && npx -y @outputty/tasks-mcp --version
0.21.0
```

npx matches the requested spec against the **local** `package.json`, finds the name already satisfied,
skips the fetch entirely, and then looks for the `tasks-mcp` binary on `PATH`. npm never creates that
link, because a package's own `bin` is not self-linked into its own `node_modules/.bin`. The published
tarball was verified fine — 0.21.0, `dist/cli.js` present, `bin` declared correctly. Only the *location*
was wrong.

The failure is silent in the worst way: MCP tools that fail to connect are simply absent, and an absent
tool looks like a tool that was never configured.

Fixed by launching the local build, which is what dogfooding wanted anyway:

```
AFTER
  { "mcpServers": { "tasks": { "command": "node", "args": ["dist/cli.js"] } } }
```

That trade is deliberate: this repository should exercise the code in front of you, not the last
release. It adds a `npm run build` precondition, which `npm run check` already satisfies.

## 4. Where it showed, and whether it repeats

1. `0fc9a58` — added the npx-based `.mcp.json` to this repository. Committed, reviewed, merged.
2. `c31dcde` — the fix, this session.
3. The session that added it filed no task and reported nothing, because the failure mode is absence:
   nothing errors, tools are just missing.
4. `.claude/lessons.md` already holds the neighbouring rule from the channel's history — *"if a feature
   only works when someone remembers a flag, the flag is the bug"* — and this is its sibling: if a
   feature only works somewhere other than here, the config is the bug.
5. The same commit's `--sync-interval 60` was also dead, feeding a drain deleted in `0a940dd`.

×1. The general trap is any self-hosting tool: a CLI, a linter, a formatter or a generator that its own
repository consumes cannot reach itself through a resolver that prefers the local package.

## 5. How to prevent it

**A repository that dogfoods its own published package launches it from the local build, never through a
package-name resolver.** `node dist/cli.js`, not `npx <own-name>`. The resolver's behaviour changes with
the working directory, and the working directory is exactly what differs between the repository and
every user.

**When wiring a tool into the repository that publishes it, run the launch command once from the
repository root before committing it.** One command settles it:

```
$ node dist/cli.js --version   # or the equivalent for the tool being wired
```

And treat *absent* MCP tools as a failure to investigate, not a configuration that was never added —
`claude mcp list` reports the connection error that the missing tools do not.
