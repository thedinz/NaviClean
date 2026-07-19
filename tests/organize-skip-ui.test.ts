import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";

test("organizer exposes persistent skipped tracks with retry and Spotify options", async () => {
  const appSource = await fs.readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(appSource, /id: "skipped", label: "Skipped"/);
  assert.match(appSource, /"\/organize\/skip"/);
  assert.match(appSource, /"Skip track"/);
  assert.match(appSource, /"Retry organization"/);
  assert.match(appSource, /organizationSkipped &&[\s\S]+Find on Spotify/);
});
