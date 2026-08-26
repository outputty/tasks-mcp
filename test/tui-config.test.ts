// The console's own config file, <cacheDir>/console.yaml — a pure filesystem read/write, zod-parsed like
// every other config in this package. Beside the caches, never in a repo, and NOT ProjectConfigSchema.

import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import { readTrackers, saveTracker } from "../src/tui/config.ts";
import { tmp } from "./helpers.ts";

test("a missing console.yaml is empty, not an error", () => {
  const cache = tmp();
  expect(readTrackers(cache.dir)).toEqual([]);
  cache.cleanup();
});

test("saveTracker appends to <cacheDir>/console.yaml and reads back, de-duplicated", () => {
  const cache = tmp();
  saveTracker(cache.dir, "http://a:3917");
  saveTracker(cache.dir, "http://b:3917");
  saveTracker(cache.dir, "http://a:3917"); // duplicate — ignored
  expect(readTrackers(cache.dir).map((t) => t.url)).toEqual(["http://a:3917", "http://b:3917"]);
  expect(fs.existsSync(path.join(cache.dir, "console.yaml"))).toBe(true);
  cache.cleanup();
});

test("a malformed console.yaml fails loudly, naming the file", () => {
  const cache = tmp();
  const file = path.join(cache.dir, "console.yaml");
  fs.writeFileSync(file, "trackers:\n  - url: http://a\n    junk: 1\n"); // unknown key (strict schema)
  expect(() => readTrackers(cache.dir)).toThrow(/console\.yaml/);
  cache.cleanup();
});

test("an unknown top-level key in console.yaml also fails, naming the file", () => {
  const cache = tmp();
  fs.writeFileSync(path.join(cache.dir, "console.yaml"), "trackers: []\nnope: true\n");
  expect(() => readTrackers(cache.dir)).toThrow(/console\.yaml/);
  cache.cleanup();
});
