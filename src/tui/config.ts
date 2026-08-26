// The console's OWN configuration — the list of trackers it connects to, at <cacheDir>/console.yaml,
// beside the task caches and NEVER inside a repository (the rule central config already sets). It is
// deliberately NOT part of ProjectConfigSchema: that schema is strict and describes what backs a
// project, and a tracker list is not a project preference. The console's in-process tracker is implicit
// and never written here. zod-parsed like every other config file: a bad file fails loudly, naming it.

import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";

const TrackerEntrySchema = z.object({ url: z.string().min(1) }).strict();

/** The console config file's shape — a list of tracker URLs, and nothing else. */
export const ConsoleConfigSchema = z
  .object({ trackers: z.array(TrackerEntrySchema).optional() })
  .strict();

export type TrackerEntry = z.infer<typeof TrackerEntrySchema>;

function consoleFile(cacheDir: string): string {
  return path.join(cacheDir, "console.yaml");
}

/**
 * The saved trackers from `<cacheDir>/console.yaml`. A missing file is empty, not an error; a malformed
 * one (an unknown key, a mistyped value) throws naming the file. The implicit in-process tracker is not
 * here — it exists whether or not the file does.
 *
 * `readTrackers("/empty-cache")` → `[]`.
 */
export function readTrackers(cacheDir: string): TrackerEntry[] {
  const file = consoleFile(cacheDir);
  if (!fs.existsSync(file)) return [];
  const parsed = ConsoleConfigSchema.safeParse(parse(fs.readFileSync(file, "utf8")) ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid console config ${file} — ${issues}`);
  }
  return parsed.data.trackers ?? [];
}

/** Append a tracker URL to `console.yaml` (creating it), de-duplicated. The write is the ONLY thing that
 *  puts a tracker on disk — the in-process tracker is never saved. */
export function saveTracker(cacheDir: string, url: string): void {
  const current = readTrackers(cacheDir);
  if (current.some((t) => t.url === url)) return;
  const file = consoleFile(cacheDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringify({ trackers: [...current, { url }] }));
}
