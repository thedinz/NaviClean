import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TrackFile } from "../src/shared/types.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-mb-identify-"));
process.env.NAVICLEAN_DATA_DIR = path.join(root, "data");
const { identifyByMusicBrainzText } = await import("../src/server/mb-identify.js");
const { confirmIdentificationCandidate } = await import("../src/server/identification.js");
const { loadMetadataOverrides } = await import("../src/server/track-decisions.js");
const { normalizeSettings } = await import("../src/server/settings.js");
const { preferredRelease } = await import("../src/server/musicbrainz.js");
const { closeDbForTests } = await import("../src/server/db.js");

const release = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Blue Album",
  status: "Official",
  date: "2001-05-01",
  "artist-credit": [{ name: "The Band", artist: { id: "22222222-2222-4222-8222-222222222222", name: "The Band" } }],
  "release-group": { id: "33333333-3333-4333-8333-333333333333", title: "Blue Album", "primary-type": "Album" },
  media: [{
    position: 1,
    format: "CD",
    "track-count": 2,
    tracks: [
      { id: "44444444-4444-4444-8444-444444444441", position: 1, number: "1", title: "Opening Song", length: 200_000,
        recording: { id: "55555555-5555-4555-8555-555555555551", title: "Opening Song", length: 200_000, isrcs: ["USAAA0100001"] } },
      { id: "44444444-4444-4444-8444-444444444442", position: 2, number: "2", title: "Second Song", length: 185_000,
        recording: { id: "55555555-5555-4555-8555-555555555552", title: "Second Song", length: 185_000 } }
    ]
  }]
};

test.after(async () => {
  closeDbForTests();
  await fs.rm(root, { recursive: true, force: true });
});

test("folder text search matches every track of an album with two MusicBrainz requests", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (url.pathname === "/ws/2/release" && url.searchParams.get("query")) {
      return Response.json({ releases: [{ ...release, media: undefined, score: 100 }] });
    }
    if (url.pathname === `/ws/2/release/${release.id}`) {
      return Response.json(release);
    }
    return new Response("not found", { status: 404 });
  });

  const settings = normalizeSettings({ naming: { libraryPath: path.join(root, "music") } as never });
  const tracks = [
    localTrack("a", "The Band/Blue Album/01 - Opening Song.mp3", "Opening Song", 1, 199),
    localTrack("b", "The Band/Blue Album/02 - Second Song.mp3", "Second Song", 2, 186)
  ];

  const result = await identifyByMusicBrainzText(settings, tracks);

  assert.equal(result.identified, 2);
  assert.deepEqual(requests, ["/ws/2/release", `/ws/2/release/${release.id}`]);
  const first = result.tracks[0].identification;
  assert.equal(first?.status, "recording-identified-release-ambiguous");
  assert.equal(first?.candidateSource, "musicbrainz-search");
  assert.equal(first?.candidates?.[0]?.recordingId, "55555555-5555-4555-8555-555555555551");
  assert.equal(first?.candidates?.[0]?.releaseTrackId, "44444444-4444-4444-8444-444444444441");
  assert.ok((first?.candidates?.[0]?.score ?? 1) <= 0.9, "text matches never auto-confirm");

  // Confirming one track applies the release to its folder and is remembered without a fingerprint.
  const confirmed = await confirmIdentificationCandidate(settings, result.tracks, "a", first!.candidates![0].id);
  assert.deepEqual(confirmed.updatedTrackIds.sort(), ["a", "b"]);
  assert.equal(confirmed.tracks[1].musicbrainz?.recordingId, "55555555-5555-4555-8555-555555555552");
  assert.equal(confirmed.tracks[1].musicbrainz?.releaseGroupId, "33333333-3333-4333-8333-333333333333");
  const overrides = await loadMetadataOverrides();
  assert.equal(overrides.size, 2);
  assert.equal([...overrides.values()][0]?.source, "musicbrainz");
});

test("text search is skipped when disabled in settings", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async () => new Response("unexpected", { status: 500 }));
  const settings = normalizeSettings({ musicbrainz: { textSearchEnabled: false } as never });
  const result = await identifyByMusicBrainzText(settings, [localTrack("c", "X/Y/01 - Z.mp3", "Z", 1, 100)]);
  assert.equal(result.identified, 0);
  assert.equal(request.mock.callCount(), 0);
});

test("preferred release favours official digital editions with the common track count", () => {
  const chosen = preferredRelease([
    { id: "bootleg", title: "A", status: "Bootleg", media: [{ format: "Digital Media", "track-count": 10 }] },
    { id: "cd", title: "A", status: "Official", country: "DE", date: "2001", media: [{ format: "CD", "track-count": 10 }] },
    { id: "digital", title: "A", status: "Official", country: "XW", date: "2002", media: [{ format: "Digital Media", "track-count": 10 }] },
    { id: "deluxe", title: "A", status: "Official", country: "XW", date: "2010", media: [{ format: "Digital Media", "track-count": 18 }] }
  ]);
  assert.equal(chosen?.id, "digital");
});

function localTrack(id: string, relativePath: string, title: string, trackNumber: number, duration: number): TrackFile {
  return {
    id,
    absolutePath: path.join(root, "music", ...relativePath.split("/")),
    relativePath,
    extension: ".mp3",
    size: 100,
    mtimeMs: 1,
    artist: "The Band",
    albumArtist: "The Band",
    album: "Blue Album",
    albumType: "Album",
    title,
    trackNumber,
    trackTotal: null,
    discNumber: null,
    discTotal: null,
    year: null,
    duration,
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
    metadataConfidence: "embedded",
    identification: { status: "candidate-only", source: "local-tags", message: "hints" },
    issues: []
  };
}
