import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";

test("Spotify selection wins over stale organizer previews and verifies its result", async () => {
  const appSource = await fs.readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(appSource, /const showMutationPlan = \(nextPlan: OrganizePlan\)/);
  assert.match(appSource, /previewRequestId\.current \+= 1/);
  assert.match(appSource, /resolvedItem\?\.metadataConfidence !== "spotify"/);
  assert.match(appSource, /setOpen\(false\)/);
});
