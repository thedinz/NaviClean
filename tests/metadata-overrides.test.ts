import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PrivateSettings } from "../src/server/settings.js";

test("a trusted path decision survives a later library scan", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-metadata-override-"));
  const dataDir = path.join(root, "data");
  process.env.NAVICLEAN_DATA_DIR = dataDir;
  const { scanLibrary } = await import("../src/server/scanner.js");
  const { saveMetadataOverridesForTracks } = await import("../src/server/metadata-overrides.js");
  const relativePath = "Artist/Artist - Real Album (2020)/Artist - Real Album (2020) - 01 - Track.mp3";

  try {
    const libraryPath = path.join(root, "music");
    const filePath = path.join(libraryPath, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "not real audio");
    const scanSettings = settings(libraryPath);
    const first = await scanLibrary(scanSettings);

    assert.equal(first.tracks[0]?.metadataConfidence, "path-suggestion");
    await saveMetadataOverridesForTracks(first.tracks, "trusted-path");

    const second = await scanLibrary(scanSettings);
    assert.equal(second.tracks[0]?.metadataConfidence, "trusted-path");
    assert.equal(second.tracks[0]?.album, "Real Album");
  } finally {
    delete process.env.NAVICLEAN_DATA_DIR;
    await fs.rm(root, { force: true, recursive: true });
  }
});

function settings(libraryPath: string): PrivateSettings {
  return {
    auth: { enabled: true, username: "admin", passwordHash: "" },
    navidrome: { baseUrl: "", username: "", password: "" },
    catalog: {
      spotify: { clientId: "", clientSecret: "", market: "US" },
      providers: { maxConcurrentDownloads: 1, opusQuality: 192, mp3FallbackEnabled: true, mp3FallbackQuality: 320 },
      discovery: { requestsPerMinute: 40 }
    },
    naming: {
      mode: "standard",
      libraryPath,
      recycleBinPath: path.join(libraryPath, ".naviclean-trash"),
      artistFolderFormat: "{Album Artist Name}",
      standardTrackFormat: "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {track:00} - {Track Title}",
      multiDiscTrackFormat: "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {medium:00}-{track:00} - {Track Title}",
      replaceIllegalCharacters: true,
      colonReplacementFormat: 4
    },
    scan: { autoScanEnabled: true, autoScanTime: "02:00", extensions: [".mp3"] },
    cleanup: { emptyFolderExclusions: [] }
  };
}
