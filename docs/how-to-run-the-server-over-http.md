# How to run the server over HTTP

Run one long-lived instance that several clients share, instead of a fresh stdio process per client.
Use this when you want a single background reconcile loop for the whole machine, or when the client
cannot spawn processes.

## Start it

```console
$ npx -y @outputty/tasks-mcp --http
tasks-mcp (http) listening on http://127.0.0.1:3917/mcp  (events: /events, health: /health)
```

That line goes to stderr, and it prints the address the server actually bound. By default that is
`127.0.0.1` — loopback only. `--port <n>` moves the port, and `--host <ip>` moves the interface (see
[Who can reach it](#who-can-reach-it) below):

```bash
npx -y @outputty/tasks-mcp --http --port 4000
```

To keep it running as a service, `npm install -g @outputty/tasks-mcp` first and point your process
manager at `tasks-mcp --http`.

## Point a client at it

```json
{
  "mcpServers": {
    "tasks": {
      "type": "http",
      "url": "http://localhost:3917/mcp"
    }
  }
}
```

The same snippet is in `.mcp.json.example` at the repository root.

## Check it is up

```console
$ curl -s http://localhost:3917/health
{"ok":true,"server":{"name":"tasks-mcp","version":"0.21.0"}}
```

There are three routes. `POST /mcp` carries the protocol; `GET /health` answers the block above; and
`GET /events` is the change stream below. `GET /mcp` returns `405` with an `Allow: POST` header (the
protocol never streams, so a held-open GET would only stall), and anything else returns `404` with
`{"error":"not found"}`.

## Follow changes with /events

An idle reader — a console, a status page — wants to know when the graph moved without polling on a
guessed interval. `GET /events` is a [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
stream that stays open and writes one line per change:

```console
$ curl -N http://127.0.0.1:3917/events
event: changed
data: {"project":"outputty/tasks-mcp","at":"2026-08-26T19:12:53.638Z"}
```

Each event names WHICH project moved and nothing more — the reader then re-reads the graph, which is
local and instant, so nothing in the stream can go stale. Two sources feed it: the server emits for the
writes it makes itself, and it watches the cache directory so a write by ANY other process — a stdio
server a client session spawned — reaches the stream too. A change carries no task data on purpose:
`fs.watch` coalesces and can arrive after the change, so the event is a signal to re-read, never a
payload.

## Turn on the background reconcile

One HTTP instance is the natural home for the loop, because it outlives any client:

```bash
tasks-mcp --http --sync-interval 60
```

It reconciles every project the instance has been asked about since it started. A project is only
known once a tool call has named it, so a freshly restarted server syncs nothing until it is used.

## What the HTTP transport does not do

Each POST gets a fresh server and transport pair, which is torn down when the response closes. There
are no session ids, nothing streams, and replies are plain JSON. Any instance can answer any request,
so you can put several behind a load balancer without sharing state — but they will each keep their
own file cache unless you point them at one with `--cache-dir`.

## Who can reach it

By default `--http` binds `127.0.0.1` — loopback only, reachable from this machine and nowhere else. The
server has no authentication of its own; it holds a GitHub token and will act on any project a caller
names, `delete_task` included. Loopback is the whole defence, so exposing it is a deliberate act:

```bash
tasks-mcp --http --host 0.0.0.0        # bind every interface — reachable across the network
```

Expose it only behind something that authenticates, on a network you trust.

> ⚠ **Breaking change (since the console-seam release).** Earlier versions bound every interface while
> logging `localhost`, so a server reachable across your network today will bind loopback only after
> upgrading and stop answering remote clients. If that was intentional, add `--host 0.0.0.0` to restore
> it — and put an authenticating proxy in front, since the surface was never meant to be open.

## Related

- [How to register the server with an MCP client](how-to-register-the-server-with-an-mcp-client.md) —
  the stdio route, which is the usual one.
- [CLI reference](reference-cli.md) — every flag, including `--cache-dir` and `--sync-interval`.
