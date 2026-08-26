// The one module that turns screen lines into OpenTUI renderables, so importing it (and the app that
// uses it) loads the native renderer. Reached only through src/tui/index.ts under --tui, which keeps the
// renderer off every server spawn. The console re-paints whole on each state change — a terminal screen
// is small, and rebuilding it is simpler than diffing renderables in place.

import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";

/**
 * Replace the renderer's content with a bordered box titled `title` and footed `footer`, one text line
 * per string in `lines`. A blank string renders as a space so vertical spacing survives.
 *
 * `paint(renderer, "tasks-mcp", "q quit", ["PROJECT  TASK", "p  t"])` → a two-line box.
 */
export function paint(renderer: CliRenderer, title: string, footer: string, lines: string[]): void {
  while (renderer.root.getChildrenCount() > 0) {
    const child = renderer.root.getChildren()[0];
    renderer.root.remove(child);
    child.destroyRecursively();
  }
  const box = new BoxRenderable(renderer, {
    title,
    bottomTitle: footer,
    border: true,
    borderStyle: "single",
    flexDirection: "column",
    flexGrow: 1,
  });
  renderer.root.add(box);
  for (const line of lines) {
    box.add(new TextRenderable(renderer, { content: line.length > 0 ? line : " " }));
  }
}
