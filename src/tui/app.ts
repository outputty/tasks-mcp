// The interactive console — a small state machine over the queue, detail and add-tracker screens. It
// owns the renderer, the LIST of connected trackers, and the current screen; every keypress runs through
// `onKey`, which mutates state, may call a write ACTION (all existing tools) on the tracker its row came
// from, and re-paints. Input is handled here rather than through OpenTUI's focusable widgets, so one
// code path drives every screen and a test can feed keys straight to `onKey` without a terminal.

import type { CliRenderer } from "@opentui/core";
import { paint as paintScreen } from "./view.ts";
import {
  connectTracker,
  fetchQueues,
  mcpEndpoint,
  probeTracker,
  type ProbeResult,
  type Tracker,
} from "./tracker.ts";
import { queueRows, type QueueRow, type ProjectQueue } from "./queue.ts";
import { saveTracker } from "./config.ts";
import {
  loadDetail,
  editFields,
  editPatch,
  applyEdit,
  changeState,
  addComment,
  fileIdea,
  type Detail,
  type EditFields,
} from "./actions.ts";
import {
  queueLines,
  detailLines,
  editLines,
  promptLines,
  addTrackerLines,
  EDIT_FIELDS,
  FIELD_OPTIONS,
} from "./format.ts";

/** The fields of a keypress the console reads — the renderer's KeyEvent satisfies it, and a test can
 *  pass a bare object (`{ name: "escape" }`), which is why the special keys are driven this way. */
export interface Key {
  name: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}

type Mode =
  | { kind: "queue" }
  | { kind: "add"; buffer: string; probed?: ProbeResult; error?: string }
  | { kind: "detail"; detail: Detail }
  | { kind: "state"; detail: Detail }
  | { kind: "edit"; detail: Detail; fields: EditFields; field: number }
  | { kind: "prompt"; detail: Detail; purpose: "comment" | "idea"; buffer: string };

export class Console {
  private mode: Mode = { kind: "queue" };
  private rows: QueueRow[] = [];
  private failures: string[] = [];
  private selected = 0;
  private active: Tracker;
  private project = "";
  private error = "";
  private busy = false;

  /** `trackers` starts with the in-process tracker; `cacheDir` is where a newly added tracker is saved;
   *  `unreachable` is saved-tracker urls that failed to connect at startup, kept visible on the queue. */
  constructor(
    private readonly renderer: CliRenderer,
    private readonly trackers: Tracker[],
    private readonly cacheDir: string,
    private readonly quit: () => void,
    private readonly unreachable: string[] = [],
  ) {
    this.active = trackers[0];
  }

  /** Wire the keyboard and draw the first frame. */
  async start(): Promise<void> {
    this.renderer.keyInput.on("keypress", (key: Key) => void this.onKey(key));
    await this.refresh();
    this.render();
  }

  /** Re-read every tracker's queue and merge — the one source both screens read, so a write never
   *  patches a local copy. A tracker that fails is recorded in `failures`, not fatal. */
  async refresh(): Promise<void> {
    this.rows = queueRows(await this.fetchAll());
    if (this.selected >= this.rows.length) this.selected = Math.max(0, this.rows.length - 1);
  }

  private async fetchAll(): Promise<ProjectQueue[]> {
    this.failures = [];
    const all: ProjectQueue[] = [];
    for (const t of this.trackers) {
      try {
        all.push(...(await fetchQueues(t.client, t.id)));
      } catch {
        this.failures.push(t.url); // unreachable at read time — its rows are absent, not a crash
      }
    }
    return all;
  }

  /** Handle one key: dispatch by screen, surface any write error, re-paint. Serialized so a burst of
   *  keys during an await cannot interleave two writes. */
  async onKey(key: Key): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      await this.dispatch(key);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async dispatch(key: Key): Promise<void> {
    const mode = this.mode;
    if (mode.kind === "queue") return this.queueKey(key);
    if (mode.kind === "add") return this.addKey(key, mode);
    if (mode.kind === "detail") return this.detailKey(key, mode.detail);
    if (mode.kind === "state") return this.stateKey(key, mode.detail);
    if (mode.kind === "edit") return this.editKey(key, mode);
    return this.promptKey(key, mode);
  }

  private async queueKey(key: Key): Promise<void> {
    if (key.name === "q") return this.quit();
    if (key.name === "a") return void (this.mode = { kind: "add", buffer: "" });
    if (key.name === "up") this.selected = Math.max(0, this.selected - 1);
    if (key.name === "down") this.selected = Math.min(this.rows.length - 1, this.selected + 1);
    if (key.name === "return") await this.open();
  }

  private async open(): Promise<void> {
    const row = this.rows[this.selected];
    if (!row) return;
    this.active = this.trackerFor(row);
    this.project = row.project;
    this.mode = {
      kind: "detail",
      detail: await loadDetail(this.active.client, row.project, row.id),
    };
  }

  /** The tracker a row's writes go to — matched by the id the fetch tagged it with, so two trackers that
   *  share a project id stay distinct. Falls back to the local tracker for an untagged row. */
  private trackerFor(row: QueueRow): Tracker {
    return this.trackers.find((t) => t.id === row.tracker) ?? this.trackers[0];
  }

  private async addKey(key: Key, mode: Mode & { kind: "add" }): Promise<void> {
    if (key.name === "escape") return void (this.mode = { kind: "queue" });
    if (key.name === "return") return this.addSubmit(mode);
    mode.probed = undefined; // editing the url invalidates a prior probe
    mode.error = undefined;
    mode.buffer = applyTextKey(mode.buffer, key);
  }

  /** First ⏎ probes the address; a second ⏎ (once it is proven) saves it. */
  private async addSubmit(mode: Mode & { kind: "add" }): Promise<void> {
    if (mode.probed) return this.saveNew(mode.buffer);
    try {
      mode.probed = await probeTracker(mode.buffer);
      mode.error = undefined;
    } catch (e) {
      mode.error = e instanceof Error ? e.message : String(e); // shown in the form; nothing is saved
      mode.probed = undefined;
    }
  }

  private async saveNew(url: string): Promise<void> {
    saveTracker(this.cacheDir, url);
    this.trackers.push({ id: url, url, client: await connectTracker(mcpEndpoint(url)) });
    await this.refresh();
    this.mode = { kind: "queue" };
  }

  private detailKey(key: Key, detail: Detail): void {
    if (key.name === "escape") this.mode = { kind: "queue" };
    if (key.name === "e")
      this.mode = { kind: "edit", detail, fields: editFields(detail.task), field: 0 };
    if (key.name === "s") this.mode = { kind: "state", detail };
    if (key.name === "c") this.mode = { kind: "prompt", detail, purpose: "comment", buffer: "" };
    if (key.name === "n") this.mode = { kind: "prompt", detail, purpose: "idea", buffer: "" };
  }

  private async stateKey(key: Key, detail: Detail): Promise<void> {
    if (key.name === "escape") return void (this.mode = { kind: "detail", detail });
    const to = { s: "start", c: "close", r: "replan" }[key.name] as
      | "start"
      | "close"
      | "replan"
      | undefined;
    if (!to) return;
    await changeState(this.active.client, this.project, detail.task.id, to);
    await this.refresh();
    this.mode = { kind: "queue" }; // a close drops the row; start/replan changed it — the queue is truth
  }

  private async editKey(key: Key, mode: Mode & { kind: "edit" }): Promise<void> {
    if (key.name === "escape") return void (this.mode = { kind: "detail", detail: mode.detail });
    if (key.name === "up") mode.field = Math.max(0, mode.field - 1);
    else if (key.name === "down") mode.field = Math.min(EDIT_FIELDS.length - 1, mode.field + 1);
    else if (key.name === "left") cycle(mode, -1);
    else if (key.name === "right") cycle(mode, 1);
    else if (key.name === "return") return this.saveEdit(mode);
    else typeInto(mode, key);
  }

  private async saveEdit(mode: Mode & { kind: "edit" }): Promise<void> {
    const patch = editPatch(editFields(mode.detail.task), mode.fields);
    await applyEdit(this.active.client, this.project, mode.detail.task.id, patch);
    await this.reopen(mode.detail.task.id);
  }

  private async promptKey(key: Key, mode: Mode & { kind: "prompt" }): Promise<void> {
    if (key.name === "escape") return void (this.mode = { kind: "detail", detail: mode.detail });
    if (key.name === "return") return this.submitPrompt(mode);
    mode.buffer = applyTextKey(mode.buffer, key);
  }

  private async submitPrompt(mode: Mode & { kind: "prompt" }): Promise<void> {
    const id = mode.detail.task.id;
    if (mode.purpose === "comment")
      await addComment(this.active.client, this.project, id, mode.buffer);
    else await fileIdea(this.active.client, this.project, `idea-${Date.now()}`, mode.buffer);
    await this.reopen(id);
  }

  /** After a write, re-read the queue AND re-open the item, so both screens reflect the change without a
   *  manual refresh (a trail write raises no /events, so this is the only way its new entry appears). */
  private async reopen(id: string): Promise<void> {
    await this.refresh();
    this.mode = { kind: "detail", detail: await loadDetail(this.active.client, this.project, id) };
  }

  private render(): void {
    const footer = this.error.length > 0 ? `⚠ ${this.error}` : this.footer();
    paintScreen(this.renderer, this.title(), footer, this.lines());
  }

  private lines(): string[] {
    const mode = this.mode;
    if (mode.kind === "queue")
      return [...queueLines(this.rows, this.selected), ...this.failureLines()];
    if (mode.kind === "add") return addTrackerLines(mode.buffer, mode.probed, mode.error);
    if (mode.kind === "edit") return editLines(mode.fields, mode.field);
    if (mode.kind === "prompt") return promptLines(promptLabel(mode.purpose), mode.buffer);
    if (mode.kind === "state") {
      return [...detailLines(mode.detail), " ", "state — [s]tart · [c]lose · [r]eplan · esc"];
    }
    return detailLines(mode.detail);
  }

  private failureLines(): string[] {
    const urls = [...new Set([...this.unreachable, ...this.failures])];
    return urls.map((url) => `⚠ unreachable: ${url}`);
  }

  private title(): string {
    const mode = this.mode;
    if (mode.kind === "queue") return `tasks-mcp — ${count(this.rows.length)}`;
    if (mode.kind === "add") return "add tracker";
    return `${mode.detail.task.id} — ${this.project}`;
  }

  private footer(): string {
    const mode = this.mode;
    if (mode.kind === "queue") return "↑↓ move · ⏎ open · a add tracker · q quit";
    if (mode.kind === "detail") return "e edit · s state · c comment · n new idea · esc back";
    if (mode.kind === "add") return addFooter(mode);
    return "esc cancel";
  }
}

/** Cycle the selected field through its closed value set; a free-text field has none and is skipped. */
function cycle(mode: Mode & { kind: "edit" }, dir: 1 | -1): void {
  const field = EDIT_FIELDS[mode.field];
  const opts = FIELD_OPTIONS[field];
  if (!opts) return;
  const i = Math.max(0, opts.indexOf(mode.fields[field]));
  mode.fields[field] = opts[(i + dir + opts.length) % opts.length];
}

/** Type into a free-text field (title, deps); enum fields are cycled, not typed. */
function typeInto(mode: Mode & { kind: "edit" }, key: Key): void {
  const field = EDIT_FIELDS[mode.field];
  if (FIELD_OPTIONS[field]) return;
  mode.fields[field] = applyTextKey(mode.fields[field], key);
}

/** Apply one key to a text buffer: backspace removes the last character, a printable one appends, any
 *  other key leaves it unchanged. The three text screens — a url, a comment, an edit field — share it. */
function applyTextKey(current: string, key: Key): string {
  if (key.name === "backspace") return current.slice(0, -1);
  if (printable(key)) return current + key.sequence;
  return current;
}

/** A single printable character (space included), not a control chord. */
function printable(key: Key): boolean {
  return !key.ctrl && !key.meta && (key.sequence?.length ?? 0) === 1 && key.sequence! >= " ";
}

function addFooter(mode: Mode & { kind: "add" }): string {
  if (mode.error) return "esc cancel";
  return mode.probed ? "⏎ save · esc cancel" : "⏎ test · esc cancel";
}

function promptLabel(purpose: "comment" | "idea"): string {
  return purpose === "comment" ? "comment:" : "new idea (title):";
}

function count(n: number): string {
  return `${n} item${n === 1 ? "" : "s"}`;
}
