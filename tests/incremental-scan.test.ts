import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { ScanStatus } from "../src/shared/types.js";

const execFileAsync = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-incremental-"));
process.env.NAVICLEAN_DATA_DIR = path.join(root, "data");
const { scanLibrary, ScanCancelledError } = await import("../src/server/scanner.js");
const { normalizeSettings } = await import("../src/server/settings.js");
const { buildOrganizePlan } = await import("../src/server/organizer.js");
const { closeDbForTests } = await import("../src/server/db.js");

const recordingId = "8f3471b5-7e6a-48da-86a9-c1c07a0f47ae";
const releaseId = "d2c0b4c5-3ba1-4dc8-a1b6-8f1b8b7d2a11";
const releaseGroupId = "0b4f3c48-3f7b-4a2f-9df1-3c1b6f1d7a55";

// Keep MusicBrainz text search offline: every lookup finds nothing.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ releases: [], recordings: [] });

test.after(async () => {
  globalThis.fetch = originalFetch;
  closeDbForTests();
  await fs.rm(root, { recursive: true, force: true });
});

test("a second scan reuses cached tags for unchanged files and re-reads changed ones", async () => {
  const library = path.join(root, "cache-library");
  const first = path.join(library, "Artist", "Album", "01 - One.mp3");
  const second = path.join(library, "Artist", "Album", "02 - Two.mp3");
  await fs.mkdir(path.dirname(first), { recursive: true });
  await fs.writeFile(first, "not real audio one");
  await fs.writeFile(second, "not real audio two");
  const settings = normalizeSettings({ naming: { libraryPath: library, recycleBinPath: path.join(root, "trash") } as never });

  await scanLibrary(settings);
  const progress: Partial<ScanStatus>[] = [];
  const rescan = await scanLibrary(settings, (update) => progress.push({ ...update }));
  assert.equal(rescan.tracks.length, 2);
  assert.equal(progress.filter((update) => typeof update.cachedFiles === "number").at(-1)?.cachedFiles, 2);
  assert.ok(rescan.warnings.some((warning) => /reused cached tags for 2 unchanged files/.test(warning)));

  await fs.writeFile(second, "changed content with a new size");
  const changed = await scanLibrary(settings);
  assert.ok(changed.warnings.some((warning) => /reused cached tags for 1 unchanged files and read 1 new or changed/.test(warning)));
});

test("files tagged with MusicBrainz recording and release IDs are trusted without review", async (t) => {
  if (!(await commandAvailable("ffmpeg"))) {
    t.skip("ffmpeg is required to create tagged audio");
    return;
  }

  const library = path.join(root, "mbid-library");
  const filePath = path.join(library, "Unsorted", "track.flac");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-metadata", "title=Tagged Song",
    "-metadata", "artist=Tagged Artist",
    "-metadata", "album_artist=Tagged Artist",
    "-metadata", "album=Tagged Album",
    "-metadata", "track=3",
    "-metadata", "date=2019",
    "-metadata", `MUSICBRAINZ_TRACKID=${recordingId}`,
    "-metadata", `MUSICBRAINZ_ALBUMID=${releaseId}`,
    "-metadata", `MUSICBRAINZ_RELEASEGROUPID=${releaseGroupId}`,
    filePath
  ]);
  const settings = normalizeSettings({ naming: { libraryPath: library, recycleBinPath: path.join(root, "trash") } as never });

  const result = await scanLibrary(settings);
  const track = result.tracks[0];
  assert.equal(track?.musicbrainz?.recordingId, recordingId);
  assert.equal(track?.musicbrainz?.releaseId, releaseId);
  assert.equal(track?.identification?.status, "musicbrainz-tagged");
  assert.equal(track?.identification?.releaseGroupId, releaseGroupId);

  const plan = await buildOrganizePlan(result.tracks, settings);
  assert.equal(plan.summary.metadataReview, 0);
  assert.equal(plan.items[0]?.status, "ready");
  assert.equal(
    plan.items[0]?.targetRelativePath,
    "Tagged Artist/Tagged Artist - Tagged Album (2019)/Tagged Artist - Tagged Album (2019) - 03 - Tagged Song.flac"
  );
});

test("a cancelled scan stops without replacing the catalog", async () => {
  const library = path.join(root, "cancel-library");
  await fs.mkdir(path.join(library, "Artist"), { recursive: true });
  await fs.writeFile(path.join(library, "Artist", "track.mp3"), "not real audio");
  const settings = normalizeSettings({ naming: { libraryPath: library, recycleBinPath: path.join(root, "trash") } as never });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(scanLibrary(settings, undefined, { signal: controller.signal }), ScanCancelledError);
});

async function commandAvailable(command: string) {
  try {
    await execFileAsync(command, ["-version"]);
    return true;
  } catch {
    return false;
  }
}
