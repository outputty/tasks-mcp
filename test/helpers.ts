import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
