// The trail store — per-task, append-only journals that let a later session backtrack the decisions
// and actions behind a task. UNLIKE the file layer, a trail is DURABLE local memory: one YAML file per
// task under `.trails/` in the repo root (path configurable), committable, and NEVER synced to a
// remote. Nothing rebuilds it, so a corrupt trail is surfaced, never quarantined.
//
// Writes are a TEXT APPEND, never a rewrite. outputty's original tracker refused to write trails at all
// because `YAML.stringify` flattens `|` block scalars and destroys hand-authored prose (see the plugin's
// tasks.js). Appending one list item leaves every earlier byte untouched, so that prose survives every
// later entry — the reason for the old read-only rule is honored, not broken.

import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { TrailEntry } from "./types.ts";
import { TRAIL_KINDS } from "./types.ts";
import type { ConfigProvider } from "./providers/config.ts";

const HEADER =
  "# tasks-mcp trails — per-task journal, append-only. Safe to commit; never synced to a remote.\n";

/** A task id used as a file name must not escape the trails directory. */
function fileName(id: string): string {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`trail id '${id}' is not a safe file name`);
  }
  return `${id}.yaml`;
}

/** Validate and tidy one entry: default kind to "note", require a note, keep key order kind/note/link. */
function normalizeEntry(entry: TrailEntry): TrailEntry {
  const kind = entry.kind ?? "note";
  if (!(TRAIL_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`unknown trail kind '${kind}' (kinds: ${TRAIL_KINDS.join(", ")})`);
  }
  const note = typeof entry.note === "string" ? entry.note.trim() : "";
  if (!note) throw new Error("a trail entry needs a note");
  const clean: TrailEntry = { kind, note };
  if (entry.link) clean.link = entry.link;
  return clean;
}

/** Parse a trail file's text into its entries, failing loud (with the path) rather than hiding data. */
function parseTrail(text: string, file: string): TrailEntry[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new Error(`${file}: unreadable trail YAML — ${(err as Error).message}`);
  }
  if (doc === null || doc === undefined) return [];
  if (!Array.isArray(doc)) throw new Error(`${file}: a trail must be a YAML list of entries`);
  return doc as TrailEntry[];
}

/** The per-task trail journals for a project. One class, backed by one file per task. */
export class TrailStore {
  constructor(private readonly config: ConfigProvider) {}

  /** The directory holding this project's trails: `<project>/.trails` unless configured otherwise. */
  dirFor(project: string): string {
    const configured = this.config.get(project).trailsDir ?? ".trails";
    return path.isAbsolute(configured) ? configured : path.join(project, configured);
  }

  private fileFor(project: string, id: string): string {
    return path.join(this.dirFor(project), fileName(id));
  }

  /** A task's trail, oldest entry first. An unwritten trail is empty, not an error. */
  read(project: string, id: string): TrailEntry[] {
    const file = this.fileFor(project, id);
    if (!fs.existsSync(file)) return [];
    return parseTrail(fs.readFileSync(file, "utf8"), file);
  }

  /** Append one entry and return the whole trail. The append never rewrites the earlier entries. */
  append(project: string, id: string, entry: TrailEntry): TrailEntry[] {
    const clean = normalizeEntry(entry);
    const file = this.fileFor(project, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, this.appendPrefix(file) + stringify([clean], { lineWidth: 0 }));
    return this.read(project, id);
  }

  /** What to write before the new entry: the header for a new file, or a newline guard for a file a
   *  hand-edit left without a trailing newline — so a concatenated entry can never fuse onto a line. */
  private appendPrefix(file: string): string {
    if (!fs.existsSync(file)) return HEADER;
    const current = fs.readFileSync(file, "utf8");
    return current.length === 0 || current.endsWith("\n") ? "" : "\n";
  }
}
