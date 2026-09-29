import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { SpotifyMetadataMatch, TrackFile } from "../src/shared/types.js";

const execFileAsync = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-confidence-"));
process.env.NAVICLEAN_DATA_DIR = path.join(root, "data");
const { analyzeOrganizeChange, parseStandardPath } = await import("../src/server/organize-changes.js");
const { applyOrganizePlan, buildOrganizePlan, namingYear, targetForTrack } = await import("../src/server/organizer.js");
const { fillOriginalYearsFromReleaseGroups } = await import("../src/server/identification.js");
const { crossCheckTrack } = await import("../src/server/organize-crosscheck.js");
const { listOrganizeRuns, startOrganizeRun, tracksAfterUndo, undoOrganizeRun } = await import("../src/server/organize-journal.js");
const { normalizeSettings } = await import("../src/server/settings.js");
const { closeDbForTests } = await import("../src/server/db.js");

const libraryPath = path.join(root, "library");
const settings = normalizeSettings({ naming: { libraryPath, recycleBinPath: path.join(root, "trash") } as never });
const standard = (year: string, title = "On My Own (Skeler Remix)") =>
  `skeler/skeler. - On My Own (Skeler Remix) (${year})/skeler. - On My Own (Skeler Remix) (${year}) - 01 - ${title}.flac`;

test.after(async () => {
  closeDbForTests();
  await fs.rm(root, { recursive: true, force: true });
});

test("folder names use the original release year instead of a reissue's date", () => {
  const reissue = track({ relativePath: "Unsorted/a.flac", year: 2024, originalYear: 2023 });
  assert.equal(namingYear(reissue), 2023);
  assert.match(targetForTrack(reissue, settings).targetRelativePath, /\(2023\)/);
});

test("a folder that already shows either known year is not renamed", () => {
  assert.equal(namingYear(track({ relativePath: standard("2024"), year: 2024, originalYear: 2023 })), 2024);
  assert.equal(namingYear(track({ relativePath: standard("2023"), year: 2024, originalYear: null })), 2024);
  assert.equal(namingYear(track({ relativePath: standard("2023"), year: 2024, originalYear: 2023 })), 2023);
});

test("the standard layout parses even when names contain ' - '", () => {
  assert.deepEqual(parseStandardPath("A - B/A - B - Live - At Home (1999)/A - B - Live - At Home (1999) - 02-07 - Song - Edit.mp3"), {
    albumArtist: "A - B",
    album: "Live - At Home",
    year: "1999",
    track: "02-07",
    title: "Song - Edit"
  });
  assert.equal(parseStandardPath("Artist/Album/01 Song.mp3"), null);
});

test("a year-only change is its own bucket and says where the year came from", () => {
  const item = analyzeOrganizeChange(track({ year: 2024, originalYear: null, identification: tagged() }), standard("2023"), standard("2024"));
  assert.equal(item.changeKind, "year");
  assert.deepEqual(item.changes.map((change) => [change.field, change.from, change.to]), [["year", "2023", "2024"]]);
  assert.equal(item.changes[0].source, "this file's own tags (release date)");
});

test("case and punctuation changes are formatting only; a real title change is an identity change", () => {
  const cosmetic = analyzeOrganizeChange(track(), standard("2023", "on my own (skeler remix)"), standard("2023"));
  assert.equal(cosmetic.changeKind, "cosmetic");
  assert.equal(cosmetic.changes[0].cosmetic, true);

  const renamed = analyzeOrganizeChange(track({ metadataConfidence: "spotify" }), standard("2023", "On My Own"), standard("2024"));
  assert.equal(renamed.changeKind, "identity");
  assert.ok(renamed.changes.every((change) => change.source.startsWith("the Spotify release you selected")));
});

test("files outside the standard layout are their own bucket", () => {
  const result = analyzeOrganizeChange(track(), "Downloads/some file.flac", standard("2023"));
  assert.equal(result.changeKind, "layout");
  assert.equal(result.changes[0].from, null);
});

test("the plan labels every move with its kind of change", async () => {
  const plan = await buildOrganizePlan([track({ absolutePath: path.join(libraryPath, "missing.flac"), relativePath: "missing.flac" })], settings);
  assert.equal(plan.items[0].changeKind, "layout");
});

test("MusicBrainz-tagged files whose folder year differs get the release group's first year", async () => {
  const lookups: string[] = [];
  const tracks = [
    track({ id: "a", relativePath: standard("2023"), year: 2024, identification: tagged(), musicbrainz: { releaseGroupId: "rg-1" } }),
    track({ id: "b", relativePath: standard("2023"), year: 2024, identification: tagged(), musicbrainz: { releaseGroupId: "rg-1" } }),
    // Already consistent with its folder: no lookup.
    track({ id: "c", relativePath: standard("2024"), year: 2024, identification: tagged(), musicbrainz: { releaseGroupId: "rg-2" } })
  ];
  const result = await fillOriginalYearsFromReleaseGroups(tracks, settings, undefined, async (id) => {
    lookups.push(id);
    return { "first-release-date": "2023-05-01" };
  });

  assert.deepEqual(lookups, ["rg-1"]);
  assert.equal(result.tracks[0].originalYear, 2023);
  assert.match(result.tracks[0].targetRelativePath, /\(2023\)/);
  assert.equal(result.tracks[2].originalYear, undefined);
});

test("Spotify cross-check agrees by ISRC and ignores ' - Remix' versus '(Remix)'", async () => {
  const queries: string[] = [];
  const result = await crossCheckTrack(
    track({ isrc: "GBX", relativePath: standard("2023"), year: 2023 }),
    async (query) => {
      queries.push(query);
      return [spotify({ name: "On My Own - Skeler Remix", album: "On My Own (Skeler Remix)", releaseYear: 2023 })];
    }
  );
  assert.deepEqual(queries, ["isrc:GBX"]);
  assert.equal(result.status, "agrees");
  assert.equal(result.method, "isrc");
});

test("Spotify cross-check reports each field that differs", async () => {
  const result = await crossCheckTrack(track({ isrc: "GBX", year: 2023 }), async () => [
    spotify({ album: "NightDrive PART III", releaseYear: 2024 })
  ]);
  assert.equal(result.status, "differs");
  assert.deepEqual(result.differences.map((difference) => difference.field), ["album", "year"]);
});

test("a text-search cross-check only counts results with the same title and artist", async () => {
  const result = await crossCheckTrack(track({ isrc: null }), async () => [
    spotify({ name: "On My Knees", artists: ["skeler."] })
  ]);
  assert.equal(result.status, "not-found");
});

test("an organize run can be undone: old path, old tags, and empty folders removed", async (t) => {
  if (!(await commandAvailable("ffmpeg")) || !(await commandAvailable("ffprobe"))) {
    t.skip("ffmpeg and ffprobe are required");
    return;
  }

  const sourcePath = path.join(libraryPath, "Downloads", "on my own.flac");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-c:a", "flac",
    "-metadata", "title=on my own", "-metadata", "date=2024", "-metadata", "comment=keep me", sourcePath
  ]);
  const stat = await fs.stat(sourcePath);
  const organizedTrack = track({
    absolutePath: sourcePath,
    relativePath: "Downloads/on my own.flac",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    year: 2024,
    originalYear: 2023,
    identification: tagged()
  });
  const target = targetForTrack(organizedTrack, settings);
  const planned = { ...organizedTrack, targetPath: target.targetPath, targetRelativePath: target.targetRelativePath };
  const plan = await buildOrganizePlan([planned], settings);
  assert.equal(plan.items[0].status, "ready");

  const run = startOrganizeRun("Test run");
  const result = await applyOrganizePlan(plan, [planned], run.record);
  const runId = run.close();
  assert.equal(result.moved, 1);
  assert.ok(runId);
  assert.equal((await probeTags(target.targetPath)).title, "On My Own (Skeler Remix)");
  assert.equal(listOrganizeRuns()[0].undoable, 1);

  const undo = await undoOrganizeRun(runId!, settings);
  assert.deepEqual(undo.errors, []);
  assert.equal(undo.moves.length, 1);
  const restoredTags = await probeTags(sourcePath);
  assert.equal(restoredTags.title, "on my own");
  assert.equal(restoredTags.date, "2024");
  assert.equal(restoredTags.comment, "keep me");
  assert.equal(restoredTags.album, undefined);
  await assert.rejects(fs.access(path.join(libraryPath, "skeler")));
  assert.equal(listOrganizeRuns()[0].undoable, 0);
  assert.ok(listOrganizeRuns()[0].undoneAt);

  const [moved] = tracksAfterUndo([{ ...planned, absolutePath: target.targetPath }], undo.moves, settings);
  assert.equal(moved.absolutePath, sourcePath);
  assert.equal(moved.relativePath, "Downloads/on my own.flac");
});

test("undo leaves a file alone when it changed after it was organized", async (t) => {
  if (!(await commandAvailable("ffmpeg")) || !(await commandAvailable("ffprobe"))) {
    t.skip("ffmpeg and ffprobe are required");
    return;
  }

  const sourcePath = path.join(libraryPath, "Loose", "changed.flac");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-c:a", "flac", sourcePath
  ]);
  const organizedTrack = track({ id: "changed", absolutePath: sourcePath, relativePath: "Loose/changed.flac", title: "Changed", identification: tagged() });
  const target = targetForTrack(organizedTrack, settings);
  const planned = { ...organizedTrack, targetPath: target.targetPath, targetRelativePath: target.targetRelativePath };
  const run = startOrganizeRun("Changed file");
  await applyOrganizePlan(await buildOrganizePlan([planned], settings), [planned], run.record);
  const runId = run.close()!;

  await fs.appendFile(target.targetPath, "edited later");
  const undo = await undoOrganizeRun(runId, settings);
  assert.equal(undo.moves.length, 0);
  assert.match(undo.errors[0], /changed after it was organized/);
  await fs.access(target.targetPath);
});

test("undo also restores MP3 MusicBrainz IDs that only taglib can write", async (t) => {
  if (!(await commandAvailable("ffmpeg")) || !(await commandAvailable("ffprobe"))) {
    t.skip("ffmpeg and ffprobe are required");
    return;
  }

  const { File: TagLibFile } = await import("node-taglib-sharp");
  const sourcePath = path.join(libraryPath, "Mp3", "song.mp3");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-c:a", "libmp3lame",
    "-metadata", "title=old title", sourcePath
  ]);
  const organizedTrack = track({
    id: "mp3",
    absolutePath: sourcePath,
    relativePath: "Mp3/song.mp3",
    extension: ".mp3",
    identification: { ...tagged()!, recordingId: "11111111-2222-3333-4444-555555555555", releaseId: "rel-1" }
  });
  const target = targetForTrack(organizedTrack, settings);
  const planned = { ...organizedTrack, targetPath: target.targetPath, targetRelativePath: target.targetRelativePath };
  const run = startOrganizeRun("MP3");
  await applyOrganizePlan(await buildOrganizePlan([planned], settings), [planned], run.record);
  const readRecordingId = (filePath: string) => {
    const file = TagLibFile.createFromPath(filePath);
    try {
      return file.tag.musicBrainzTrackId || "";
    } finally {
      file.dispose();
    }
  };
  assert.equal(readRecordingId(target.targetPath), "11111111-2222-3333-4444-555555555555");

  const undo = await undoOrganizeRun(run.close()!, settings);
  assert.deepEqual(undo.errors, []);
  assert.equal(readRecordingId(sourcePath), "");
  assert.equal((await probeTags(sourcePath)).title, "old title");
});

test("a scan reads Picard's originaldate and names the folder with it", async (t) => {
  if (!(await commandAvailable("ffmpeg"))) {
    t.skip("ffmpeg is required");
    return;
  }

  const { scanLibrary } = await import("../src/server/scanner.js");
  const scanRoot = path.join(root, "scan-library");
  const filePath = path.join(scanRoot, "Unsorted", "track.flac");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-c:a", "flac",
    "-metadata", "artist=Artist", "-metadata", "album_artist=Artist", "-metadata", "album=Album",
    "-metadata", "title=Song", "-metadata", "track=1", "-metadata", "date=2024-02-02", "-metadata", "originaldate=2023-01-01",
    filePath
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ releases: [], recordings: [] });
  try {
    const scanSettings = normalizeSettings({
      naming: { libraryPath: scanRoot, recycleBinPath: path.join(root, "scan-trash") } as never,
      musicbrainz: { textSearchEnabled: false, maxTextLookupsPerScan: 0, catalogSource: "musicbrainz" } as never
    });
    const { tracks } = await scanLibrary(scanSettings);
    assert.equal(tracks[0].year, 2024);
    assert.equal(tracks[0].originalYear, 2023);
    assert.equal(tracks[0].targetRelativePath, "Artist/Artist - Album (2023)/Artist - Album (2023) - 01 - Song.flac");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function probeTags(filePath: string) {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format_tags", "-of", "json", filePath]);
  const tags = (JSON.parse(stdout) as { format?: { tags?: Record<string, string> } }).format?.tags ?? {};
  return Object.fromEntries(Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value])) as Record<string, string | undefined>;
}

async function commandAvailable(command: string) {
  try {
    await execFileAsync(command, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

function tagged(): TrackFile["identification"] {
  return { status: "musicbrainz-tagged", source: "musicbrainz", message: "tagged" };
}

function spotify(overrides: Partial<SpotifyMetadataMatch> = {}): SpotifyMetadataMatch {
  return {
    id: "sp-1",
    name: "On My Own (Skeler Remix)",
    artists: ["skeler."],
    albumArtist: "skeler.",
    albumId: "al-1",
    album: "On My Own (Skeler Remix)",
    albumType: "single",
    releaseDate: "2023-01-01",
    releaseYear: 2023,
    imageUrl: null,
    discNumber: 1,
    trackNumber: 1,
    duration: 180,
    isrc: "GBX",
    spotifyUrl: "https://open.spotify.com/track/sp-1",
    ...overrides
  };
}

function track(overrides: Partial<TrackFile> = {}): TrackFile {
  return {
    id: "track-1",
    absolutePath: path.join(libraryPath, "old.flac"),
    relativePath: "old.flac",
    extension: ".flac",
    size: 1,
    mtimeMs: 1,
    artist: "skeler.",
    albumArtist: "skeler.",
    album: "On My Own (Skeler Remix)",
    albumType: "Single",
    title: "On My Own (Skeler Remix)",
    trackNumber: 1,
    trackTotal: 1,
    discNumber: 1,
    discTotal: 1,
    year: 2023,
    duration: 180,
    bitrate: null,
    sampleRate: null,
    bitsPerSample: null,
    codec: null,
    container: null,
    lossless: true,
    duplicateKey: "",
    qualityScore: 0,
    targetPath: "",
    targetRelativePath: "",
    issues: [],
    ...overrides
  };
}
