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

test("unmatched Navidrome files have a dedicated organizer filter with Spotify resolution", async () => {
  const appSource = await fs.readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(appSource, /id: "navidrome-unmatched", label: "Navidrome unmatched"/);
  assert.match(appSource, /item\.navidromeEnrichment\?\.status === "unmatched"/);
  assert.match(appSource, /<SpotifyMetadataResolver[\s\S]+item=\{item\}/);
});

test("Diagnostics exposes Spotify resolution and refreshes unmatched files after selection", async () => {
  const appSource = await fs.readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");

  assert.match(appSource, /function UnindexedTable[\s\S]+<th>Resolve<\/th>/);
  assert.match(appSource, /useSpotifyMetadataSearch\(track, onSpotifyResolved\)/);
  assert.match(appSource, /const spotifyResolved = async[\s\S]+await load\(\{ quiet: true \}\)/);
});

test("Diagnostics keeps Spotify resolution before wide detail columns", async () => {
  const appSource = await fs.readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const styles = await fs.readFile(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(appSource, /<th>Track<\/th>\s*<th>Resolve<\/th>\s*<th>Current path<\/th>/);
  assert.match(styles, /\.unindexed-table \{\s*min-width: 1080px/);
});

test("Diagnostics renders open Spotify results in a full-width row", async () => {
  const appSource = await fs.readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const styles = await fs.readFile(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(appSource, /<tr className="unindexed-spotify-row">\s*<td colSpan=\{7\}>/);
  assert.match(appSource, /<SpotifyMetadataSearchPanel spotify=\{spotify\} wide \/>/);
  assert.match(styles, /\.unindexed-spotify-panel \{\s*width: min\(760px, 100%\)/);
  assert.match(
    styles,
    /\[data-theme="dark"\] \.unindexed-match-row td,\s*\[data-theme="dark"\] \.unindexed-spotify-row td \{\s*background: var\(--surface-muted\)/,
  );
});
