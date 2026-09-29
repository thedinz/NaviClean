import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TrackFile } from "../src/shared/types.js";

// The database resolves its data directory when first opened, so point it at a temp dir first.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-decisions-"));
process.env.NAVICLEAN_DATA_DIR = path.join(root, "data");
const decisions = await import("../src/server/track-decisions.js");
const { closeDbForTests, execute } = await import("../src/server/db.js");

test.after(async () => {
  closeDbForTests();
  await fs.rm(root, { force: true, recursive: true });
});

test.beforeEach(() => {
  execute("DELETE FROM metadata_overrides");
  execute("DELETE FROM organize_skips");
});

test("a metadata override only applies to the file size it was confirmed against", async () => {
  const track = trackFile({ absolutePath: path.resolve("/music/A/one.mp3"), size: 10 });
  await decisions.saveMetadataOverridesForTracks([track], "trusted-path");

  const overrides = await decisions.loadMetadataOverrides();

  assert.ok(decisions.validMetadataOverride(overrides, track.absolutePath, 10));
  assert.equal(decisions.validMetadataOverride(overrides, track.absolutePath, 11), null);
});

test("decisions follow a retagged or converted file to its new path and size", async () => {
  const source = trackFile({ absolutePath: path.resolve("/music/A/one.flac"), size: 1000 });
  await decisions.saveMetadataOverridesForTracks([source], "spotify");
  decisions.saveSkipDecision({ ...source, organizeSkippedAt: "2026-07-18T12:00:00.000Z" });

  const convertedPath = path.resolve("/music/A/one.opus");
  await decisions.moveTrackDecisions([{ sourcePath: source.absolutePath, targetPath: convertedPath, size: 120 }]);
  const overrides = await decisions.loadMetadataOverrides();
  const skips = decisions.loadSkipDecisions();

  assert.equal(decisions.validMetadataOverride(overrides, source.absolutePath, 1000), null);
  assert.equal(decisions.validMetadataOverride(overrides, convertedPath, 120)?.source, "spotify");
  assert.equal(decisions.skipDecisionFor(skips, source.absolutePath), undefined);
  assert.equal(decisions.skipDecisionFor(skips, convertedPath), "2026-07-18T12:00:00.000Z");
});

test("clearing a skip removes only the skip", async () => {
  const track = trackFile({ absolutePath: path.resolve("/music/A/one.mp3") });
  await decisions.saveMetadataOverridesForTracks([track], "trusted-path");
  decisions.saveSkipDecision({ ...track, organizeSkippedAt: "2026-07-18T12:00:00.000Z" });

  decisions.saveSkipDecision({ ...track, organizeSkippedAt: undefined });

  assert.equal(decisions.skipDecisionFor(decisions.loadSkipDecisions(), track.absolutePath), undefined);
  assert.ok(decisions.validMetadataOverride(await decisions.loadMetadataOverrides(), track.absolutePath, track.size));
});

test("pruning drops decisions for files that are no longer in the library", async () => {
  const kept = trackFile({ absolutePath: path.resolve("/music/A/kept.mp3") });
  const gone = trackFile({ absolutePath: path.resolve("/music/A/gone.mp3") });
  await decisions.saveMetadataOverridesForTracks([kept, gone], "trusted-path");
  decisions.saveSkipDecision({ ...gone, organizeSkippedAt: "2026-07-18T12:00:00.000Z" });

  decisions.pruneTrackDecisions([kept.absolutePath]);
  const overrides = await decisions.loadMetadataOverrides();

  assert.equal(overrides.size, 1);
  assert.ok(decisions.validMetadataOverride(overrides, kept.absolutePath, kept.size));
  assert.equal(decisions.loadSkipDecisions().size, 0);
});

test("a skip survives a rescan through the decision store", async () => {
  const library = path.join(root, "library-skip");
  const filePath = path.join(library, "Unsorted", "01 - Song.mp3");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "audio");
  const { scanLibrary } = await import("../src/server/scanner.js");
  const { setTrackOrganizationSkipped } = await import("../src/server/organize-skip.js");
  const { normalizeSettings } = await import("../src/server/settings.js");
  const settings = normalizeSettings({ naming: { libraryPath: library, recycleBinPath: path.join(root, "trash") } });

  const first = await scanLibrary(settings);
  const skipped = setTrackOrganizationSkipped(first.tracks, first.tracks[0]!.id, true);
  decisions.saveSkipDecision(skipped.tracks[0]!);
  const second = await scanLibrary(settings);

  assert.ok(second.tracks[0]?.organizeSkippedAt);
});

function trackFile(overrides: Partial<TrackFile> = {}): TrackFile {
  return {
    id: "track-1",
    absolutePath: path.resolve("/music/Artist/track.mp3"),
    relativePath: "Artist/track.mp3",
    extension: ".mp3",
    size: 10,
    mtimeMs: 1,
    artist: "Artist",
    albumArtist: "Artist",
    album: "Album",
    albumType: "Album",
    title: "Track",
    trackNumber: 1,
    trackTotal: 10,
    discNumber: 1,
    discTotal: 1,
    year: 2026,
    duration: 180,
    bitrate: null,
    sampleRate: null,
    bitsPerSample: null,
    codec: null,
    container: null,
    lossless: false,
    duplicateKey: "",
    qualityScore: 0,
    targetPath: "",
    targetRelativePath: "",
    issues: [],
    ...overrides
  };
}
