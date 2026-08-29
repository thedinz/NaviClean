import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";

test("empty folder results use theme-aware surfaces", async () => {
  const styles = await fs.readFile(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(
    styles,
    /\.empty-folder-panel \{[\s\S]*?border: 1px solid var\(--border\);[\s\S]*?background: var\(--panel\);/,
  );
});

test("checkboxes keep a compact native control size across cleanup pages", async () => {
  const styles = await fs.readFile(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(
    styles,
    /input\[type="checkbox"\] \{\s*width: 18px;\s*height: 18px;\s*min-height: 18px;\s*padding: 0;\s*accent-color: var\(--accent\);/,
  );
});
