import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { withDefaults } from "../src/core/graph.ts";
import type { Task } from "../src/core/types.ts";

export const task = (over: Partial<Task> & { id: string }): Task =>
  withDefaults(over);

/** A throwaway directory; returns the path and a cleanup fn. */
export function tmp(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-mcp-"));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * A throwaway git repo whose `origin` points at github.com/outputty/demo — the repo the nock GitHub
 * serves. The provider's real repo resolution (git remote get-url) runs against it, so the whole path
 * from project dir to API stays unfaked.
 */
export function tmpRepo(): { dir: string; cleanup: () => void } {
  const t = tmp();
  spawnSync("git", ["-C", t.dir, "init", "-q"]);
  spawnSync("git", [
    "-C",
    t.dir,
    "remote",
    "add",
    "origin",
    "git@github.com:outputty/demo.git",
  ]);
  return t;
}
