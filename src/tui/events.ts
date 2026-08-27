// The console's change-stream client — one SSE subscription per connected tracker. Node has no
// EventSource (verified undefined on 26.5.0), so the stream is consumed with `fetch` and a
// ReadableStream reader, splitting frames on a blank line. A `changed` frame names the project that
// moved and is only a re-read HINT; the caller re-reads that tracker's graph rather than trusting the
// payload, which is stale by the time it is drawn. Comment frames (the server's `: connected`) are
// ignored. A refused or dropped stream reaches `onError` and the subscription stops — the console keeps
// running for its other trackers.

/** A live change-stream subscription. `close()` aborts the stream; it is idempotent and safe to call
 *  after the stream has already ended. */
export interface Subscription {
  close(): void;
}

/**
 * Subscribe to a tracker's `/events` SSE stream. `onChanged(project)` fires once per `changed` frame;
 * `onError(reason)` fires if the stream refuses to connect or drops mid-flight, and never after
 * `close()` (a deliberate close is not a failure). Returns a handle the caller closes on quit.
 *
 * `subscribeChanges("http://h/events", p => …, r => …)` → a Subscription whose reader runs until closed.
 */
export function subscribeChanges(
  url: string,
  onChanged: (project: string) => void,
  onError: (reason: string) => void,
): Subscription {
  const controller = new AbortController();
  void pump(url, controller.signal, onChanged, onError);
  return { close: () => controller.abort() };
}

/** Connect and read frames until the stream ends, the caller closes it, or it errors. A non-200 or a
 *  bodyless response is a connect failure; a mid-stream throw is a read failure — both reach `onError`
 *  unless the signal was aborted. */
async function pump(
  url: string,
  signal: AbortSignal,
  onChanged: (project: string) => void,
  onError: (reason: string) => void,
): Promise<void> {
  try {
    const res = await fetch(url, { headers: { accept: "text/event-stream" }, signal });
    if (!res.ok || !res.body) return onError(`events ${res.status}`);
    await readFrames(res.body, onChanged);
  } catch (e) {
    if (signal.aborted) return; // closed on purpose
    onError(e instanceof Error ? e.message : String(e));
  }
}

/** Read the byte stream and emit each complete `changed` frame's project. Runs until the stream ends or
 *  the reader throws — a drop, or the abort a `close()` raises. */
async function readFrames(
  body: ReadableStream<Uint8Array>,
  onChanged: (project: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunk = await reader.read();
  while (!chunk.done) {
    buffer += decoder.decode(chunk.value, { stream: true });
    buffer = emitFrames(buffer, onChanged);
    chunk = await reader.read();
  }
}

/** Emit every complete SSE frame in `buffer` (frames end at a blank line) and return the trailing
 *  partial frame, which the next read completes. */
function emitFrames(buffer: string, onChanged: (project: string) => void): string {
  let rest = buffer;
  let end = rest.indexOf("\n\n");
  while (end !== -1) {
    const project = changedProject(rest.slice(0, end));
    rest = rest.slice(end + 2);
    if (project) onChanged(project);
    end = rest.indexOf("\n\n");
  }
  return rest;
}

/** The project named by one SSE frame, or null when the frame is a comment (`: connected`), a
 *  non-`changed` event, or carries no parseable `data:` payload. */
function changedProject(frame: string): string | null {
  if (frame.startsWith(":")) return null; // a comment frame — the server's keep-alive/hello
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (event !== "changed" || data.length === 0) return null;
  return parseProject(data);
}

/** The `project` string in a `changed` frame's JSON payload, or null when it is absent or unparseable. */
function parseProject(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as { project?: unknown };
    return typeof parsed.project === "string" ? parsed.project : null;
  } catch {
    return null;
  }
}
