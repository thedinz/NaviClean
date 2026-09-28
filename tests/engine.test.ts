import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parseFile } from "music-metadata";
import type { CatalogProviderCandidate, DownloadJob, DownloadTrack } from "../src/shared/types.js";

const execFileAsync = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-engine-"));
const library = path.join(root, "music");
process.env.NAVICLEAN_DATA_DIR = path.join(root, "data");
await fs.mkdir(library, { recursive: true });

const { scoreCandidate } = await import("../src/server/engine/scoring.js");
const { durationToleranceSeconds, codecFamily } = await import("../src/server/engine/verify.js");
const { nextRetryDelayMs, listWanted } = await import("../src/server/engine/wanted.js");
const { replaceDownloadSourcesForTests } = await import("../src/server/engine/sources.js");
const jobs = await import("../src/server/engine/jobs.js");
const { listQuarantine } = await import("../src/server/engine/quarantine.js");
const { loadCatalog } = await import("../src/server/catalog.js");
const { normalizeSettings } = await import("../src/server/settings.js");
const { closeDbForTests } = await import("../src/server/db.js");

const settings = normalizeSettings({
  naming: { libraryPath: library, recycleBinPath: path.join(root, "trash") } as never
});
jobs.initializeDownloadEngine(async () => settings);

test.after(async () => {
  closeDbForTests();
  await fs.rm(root, { recursive: true, force: true });
});

const baseTrack: DownloadTrack = {
  key: "mb:rec-1:rg-1",
  catalog: "musicbrainz",
  title: "Karma Police",
  artists: ["Radiohead"],
  album: "OK Computer",
  albumArtist: "Radiohead",
  albumType: "Album",
  trackNumber: 6,
  discNumber: 1,
  trackTotal: 12,
  discTotal: 1,
  releaseDate: "1997-05-21",
  releaseYear: 1997,
  durationMs: 4_000,
  isrc: null,
  coverUrl: null,
  musicbrainz: {
    recordingId: "8f3471b5-7e6a-48da-86a9-c1c07a0f47ae",
    releaseId: "d2c0b4c5-3ba1-4dc8-a1b6-8f1b8b7d2a11",
    releaseGroupId: "0b4f3c48-3f7b-4a2f-9df1-3c1b6f1d7a55",
    releaseTrackId: "5b0c8f7e-2d1a-4c9b-9e3f-7a6d5c4b3a21"
  }
};

test("scoring prefers the release audio and penalises live, instrumental, and cover uploads", () => {
  const track = { ...baseTrack, durationMs: 264_000 };
  const topic = scoreCandidate(track, { title: "Karma Police", artists: ["Radiohead"], channel: "Radiohead - Topic", durationMs: 264_000, rank: 1 });
  const live = scoreCandidate(track, { title: 'Radiohead - "Karma Police" (1997) | David Letterman', artists: ["Letterman"], channel: "Letterman", durationMs: 276_000, rank: 3 });
  const instrumental = scoreCandidate(track, { title: "Radiohead - Karma Police (Instrumental)", artists: ["Weird Instrumentals"], channel: "Weird Instrumentals", durationMs: 262_000, rank: 6 });
  const cover = scoreCandidate(track, { title: "Panic! At The Disco - Karma Police (LIVE IN DENVER)", artists: ["Panic! At The Disco"], channel: "Panic! At The Disco", durationMs: 199_000, rank: 7 });

  assert.ok(topic.score.overall >= 90, `topic scored ${topic.score.overall}`);
  assert.ok(topic.flags.includes("topic-channel"));
  assert.ok(live.flags.includes("version:live"));
  assert.ok(instrumental.flags.includes("version:instrumental"));
  assert.ok(live.score.overall < 55 && instrumental.score.overall < 55 && cover.score.overall < 55);
});

test("a live candidate is not penalised when the requested album is itself live", () => {
  const liveAlbum = { ...baseTrack, album: "Live at the BBC", albumType: "Live", durationMs: 200_000 };
  const scored = scoreCandidate(liveAlbum, { title: "Karma Police (Live at the BBC)", artists: ["Radiohead"], channel: "Radiohead", durationMs: 200_000, rank: 0 });
  assert.ok(!scored.flags.some((flag) => flag.startsWith("version:")));
});

test("verification tolerances, codec families, and Wanted backoff", () => {
  assert.equal(durationToleranceSeconds(60), 7);
  assert.equal(durationToleranceSeconds(600), 24);
  assert.equal(codecFamily("opus"), "opus");
  assert.equal(codecFamily("mp4a.40.2"), "aac");
  assert.equal(nextRetryDelayMs(1), 60 * 60 * 1000);
  assert.equal(nextRetryDelayMs(50), 168 * 60 * 60 * 1000);
});

test("a confident candidate is downloaded, verified, tagged with MusicBrainz IDs, and imported", async (t) => {
  if (!(await commandAvailable("ffmpeg"))) {
    t.skip("ffmpeg is required");
    return;
  }
  const restore = replaceDownloadSourcesForTests([fakeSource([candidate("good", 95, 4)])]);
  t.after(restore);

  const job = await jobs.createDownloadJob({ title: "OK Computer", subtitle: "", origin: "manual", catalog: "musicbrainz", coverUrl: null, tracks: [baseTrack] });
  const finished = await waitForJob(job.id);

  assert.equal(finished.status, "completed");
  const item = finished.items[0];
  assert.equal(item.status, "completed");
  assert.equal(item.verification?.durationDeltaSeconds !== null, true);
  assert.equal(
    item.relativePath,
    "Radiohead/Radiohead - OK Computer (1997)/Radiohead - OK Computer (1997) - 06 - Karma Police.opus"
  );

  const { common } = await parseFile(path.join(library, ...item.relativePath!.split("/")));
  assert.equal(common.title, "Karma Police");
  assert.equal(common.musicbrainz_recordingid, baseTrack.musicbrainz!.recordingId);
  assert.equal(common.musicbrainz_albumid, baseTrack.musicbrainz!.releaseId);

  const catalog = await loadCatalog();
  const imported = catalog.tracks.find((track) => track.relativePath === item.relativePath);
  assert.equal(imported?.identification?.status, "musicbrainz-tagged");

  // The same track is now present, so a second request skips it.
  const again = await jobs.createDownloadJob({ title: "Again", subtitle: "", origin: "manual", catalog: "musicbrainz", coverUrl: null, tracks: [baseTrack] });
  assert.equal(again.items[0].status, "skipped");
});

test("a duration mismatch quarantines the source and the next candidate is tried", async (t) => {
  if (!(await commandAvailable("ffmpeg"))) {
    t.skip("ffmpeg is required");
    return;
  }
  const restore = replaceDownloadSourcesForTests([fakeSource([candidate("too-long", 96, 60), candidate("right-length", 90, 4)])]);
  t.after(restore);
  const track = { ...baseTrack, key: "mb:rec-2:rg-1", title: "Airbag", trackNumber: 1, musicbrainz: { ...baseTrack.musicbrainz, recordingId: undefined } };

  const job = await jobs.createDownloadJob({ title: "Airbag", subtitle: "", origin: "manual", catalog: "musicbrainz", coverUrl: null, tracks: [track] });
  const finished = await waitForJob(job.id);

  assert.equal(finished.items[0].status, "completed");
  assert.equal(finished.items[0].attempts[0]?.reason, "duration-mismatch");
  assert.ok(listQuarantine().some((entry) => entry.candidateId === "fake:too-long" && entry.trackKey === track.key));
});

test("middling matches wait for review; rejecting keeps the track in Wanted", async (t) => {
  const restore = replaceDownloadSourcesForTests([fakeSource([candidate("maybe", 65, 4)])]);
  t.after(restore);
  const track = { ...baseTrack, key: "mb:rec-3:rg-1", title: "Lucky", trackNumber: 11, musicbrainz: { ...baseTrack.musicbrainz, recordingId: "rec-3" } };

  const job = await jobs.createDownloadJob({ title: "Lucky", subtitle: "", origin: "manual", catalog: "musicbrainz", coverUrl: null, tracks: [track] });
  const held = await waitForJob(job.id, ["review"]);
  assert.equal(held.items[0].status, "review");
  assert.equal(jobs.listReviewItems().length, 1);

  jobs.rejectReviewItem(job.id, held.items[0].id, { keepWanted: true });
  assert.ok(listWanted().some((item) => item.id === track.key));
});

test("tracks with no acceptable candidate fail into Wanted", async (t) => {
  const restore = replaceDownloadSourcesForTests([fakeSource([candidate("bad", 20, 4)])]);
  t.after(restore);
  const track = { ...baseTrack, key: "mb:rec-4:rg-1", title: "The Tourist", trackNumber: 12, musicbrainz: { ...baseTrack.musicbrainz, recordingId: "rec-4" } };

  const job = await jobs.createDownloadJob({ title: "Tourist", subtitle: "", origin: "manual", catalog: "musicbrainz", coverUrl: null, tracks: [track] });
  const finished = await waitForJob(job.id);
  assert.equal(finished.status, "failed");
  assert.match(finished.items[0].error ?? "", /No confident match/);
  assert.ok(listWanted().some((item) => item.id === track.key && item.attempts === 1));
});

function candidate(id: string, score: number, seconds: number): CatalogProviderCandidate & { seconds: number } {
  return {
    id: `fake:${id}`,
    providerId: "youtube",
    title: id,
    artists: ["Radiohead"],
    url: `https://www.youtube.com/watch?v=${id.padEnd(11, "x").slice(0, 11)}`,
    verified: false,
    score: { overall: score, titleScore: score, artistScore: score },
    seconds
  };
}

function fakeSource(candidates: Array<CatalogProviderCandidate & { seconds: number }>) {
  return {
    id: "youtube" as const,
    label: "Fake",
    checkAvailability: async () => ({ available: true, message: "fake" }),
    search: async () => candidates.map(({ seconds: _seconds, ...rest }) => ({ ...rest })),
    fetch: async (chosen: CatalogProviderCandidate, options: { stagingDirectory: string; fileBase: string }) => {
      const seconds = candidates.find((entry) => entry.id === chosen.id)?.seconds ?? 4;
      const stagedPath = path.join(options.stagingDirectory, `${options.fileBase}.opus`);
      await execFileAsync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:a", "libopus", "-b:a", "128k", stagedPath]);
      return { stagedPath, sourceCodec: "opus", sourceBitrateKbps: 128 };
    }
  };
}

async function waitForJob(jobId: string, until: DownloadJob["status"][] = ["completed", "partial", "failed", "cancelled"]) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = jobs.getDownloadJob(jobId);
    if (job && until.includes(job.status)) {
      return structuredClone(job);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Job ${jobId} did not reach ${until.join("/")}: ${JSON.stringify(jobs.getDownloadJob(jobId)?.items.map((item) => [item.status, item.error]))}`);
}

async function commandAvailable(command: string) {
  try {
    await execFileAsync(command, ["-version"]);
    return true;
  } catch {
    return false;
  }
}
