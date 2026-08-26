# How to run the server over HTTP

Run one long-lived instance that several clients share, instead of a fresh stdio process per client.
Use this when you want a single background reconcile loop for the whole machine, or when the client
cannot spawn processes.

## Start it

```console
$ npx -y @outputty/tasks-mcp --http
tasks-mcp (http) listening on http://localhost:3917/mcp  (health: /health)
```

That line goes to stderr. `--port <n>` moves it:

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

There are exactly two routes. `POST /mcp` carries the protocol; `GET /health` answers the block above.
`GET /mcp` returns `405` with an `Allow: POST` header, and anything else returns `404` with
`{"error":"not found"}`.

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

The server binds whatever `node:http` binds by default and has no authentication of its own. It holds
a GitHub token and will act on any repository path a caller names. Do not expose it beyond localhost
without putting something in front of it.

## Related

- [How to register the server with an MCP client](how-to-register-the-server-with-an-mcp-client.md) —
  the stdio route, which is the usual one.
- [CLI reference](reference-cli.md) — every flag, including `--cache-dir` and `--sync-interval`.
