import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { clientSource } from "./helpers/client-source.js";

test("organizer filter and badges use current TrackKeep wording", async () => {
  const appSource = await clientSource();

  assert.match(appSource, /id: "trackkeep", label: "TrackKeep"/);
  assert.match(appSource, /filterCounts\.trackkeep[^\n]+TrackKeep/);
  assert.match(
    appSource,
    /!isTrackKeepManaged\(item\.managedBy\) && item\.metadataConfidence === "path-suggestion"/
  );
  assert.doesNotMatch(appSource, /label: "SpotifyBU"/);
});
