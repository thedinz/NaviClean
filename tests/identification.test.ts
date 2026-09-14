import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TrackFile, TrackIdentificationCandidate } from "../src/shared/types.js";
import { candidatesFromAcoustId, identificationNeedsReview, resolveReleaseConsensus } from "../src/server/identification.js";
import { buildOrganizePlan } from "../src/server/organizer.js";
import { normalizeSettings } from "../src/server/settings.js";

test("AcoustID responses become release-specific MusicBrainz candidates", () => {
  const candidates = candidatesFromAcoustId({
    status: "ok",
    results: [{
      id: "acoustid-1",
      score: 0.99,
      recordings: [{
        id: "recording-1",
        title: "Recording Title",
        duration: 181,
        artists: [{ name: "Track Artist" }],
        isrcs: ["usabc2100001"],
        releasegroups: [{
          id: "release-group-1",
          title: "Album",
          type: "Album",
          artists: [{ name: "Album Artist" }],
          releases: [{
            id: "release-1",
            title: "Album",
            date: "2021-06-04",
            medium_count: 1,
            mediums: [{
              position: 1,
              track_count: 10,
              tracks: [{
                position: 3,
                title: "Release Track Title",
                recording: { id: "recording-1" },
                artists: [{ name: "Track Artist" }]
              }]
            }]
          }]
        }]
      }]
    }]
  });

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    ...candidates[0],
    score: 0.99,
    acoustId: "acoustid-1",
    recordingId: "recording-1",
    releaseId: "release-1",
    releaseGroupId: "release-group-1",
    artist: "Track Artist",
    albumArtist: "Album Artist",
    album: "Album",
    albumType: "Album",
    title: "Release Track Title",
    trackNumber: 3,
    trackTotal: 10,
    discNumber: 1,
    discTotal: 1,
    year: 2021,
    duration: 181,
    isrc: "USABC2100001"
  });
});

test("release consensus uses a shared release but still honors the review gate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-identification-"));
  try {
    const settings = normalizeSettings({ naming: { libraryPath: root } as never });
    const firstPath = path.join(root, "Untrusted", "one.mp3");
    const secondPath = path.join(root, "Untrusted", "two.mp3");
    await fs.mkdir(path.dirname(firstPath), { recursive: true });
    await fs.writeFile(firstPath, "one");
    await fs.writeFile(secondPath, "two");
    const tracks = [
      identifiedTrack(firstPath, "Untrusted/one.mp3", candidate("one", 1)),
      identifiedTrack(secondPath, "Untrusted/two.mp3", candidate("two", 2))
    ];

    const resolved = resolveReleaseConsensus(tracks, settings);
    assert.equal(resolved[0]?.identification?.status, "fingerprint-and-release-confirmed");
    assert.equal(resolved[0]?.album, "Canonical Album");
    assert.equal(identificationNeedsReview(resolved[0]!, settings), true);
    assert.equal((await buildOrganizePlan(resolved, settings)).summary.metadataReview, 2);

    settings.identification!.requireReviewBeforeFileChanges = false;
    assert.equal((await buildOrganizePlan(resolved, settings)).summary.ready, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function candidate(title: string, trackNumber: number): TrackIdentificationCandidate {
  return {
    id: `candidate-${trackNumber}`,
    score: 0.99,
    acoustId: `acoustid-${trackNumber}`,
    recordingId: `recording-${trackNumber}`,
    releaseId: "release-shared",
    releaseGroupId: "release-group",
    artist: "Canonical Artist",
    albumArtist: "Canonical Artist",
    album: "Canonical Album",
    albumType: "Album",
    title,
    trackNumber,
    trackTotal: 2,
    discNumber: 1,
    discTotal: 1,
    year: 2020,
    duration: 180,
    isrc: null
  };
}

function identifiedTrack(absolutePath: string, relativePath: string, match: TrackIdentificationCandidate): TrackFile {
  return {
    id: relativePath,
    absolutePath,
    relativePath,
    extension: ".mp3",
    size: 3,
    mtimeMs: 1,
    artist: "Untrusted",
    albumArtist: "Untrusted",
    album: "Untrusted",
    albumType: "Album",
    title: "Untrusted",
    trackNumber: null,
    trackTotal: null,
    discNumber: null,
    discTotal: null,
    year: null,
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
    identification: {
      status: "recording-identified-release-ambiguous",
      source: "musicbrainz",
      message: "review",
      fingerprint: `fingerprint-${match.trackNumber}`,
      candidates: [match]
    },
    issues: []
  };
}
