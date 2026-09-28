import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseFile } from "music-metadata";
import { writeCanonicalTags } from "../src/server/canonical-tags.js";
import type { TrackFile } from "../src/shared/types.js";

const execFileAsync = promisify(execFile);
const ids = {
  recordingId: "8f3471b5-7e6a-48da-86a9-c1c07a0f47ae",
  releaseId: "d2c0b4c5-3ba1-4dc8-a1b6-8f1b8b7d2a11",
  releaseGroupId: "0b4f3c48-3f7b-4a2f-9df1-3c1b6f1d7a55",
  releaseTrackId: "5b0c8f7e-2d1a-4c9b-9e3f-7a6d5c4b3a21",
  artistId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
  albumArtistId: "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d"
};

const encoders: Record<string, string[]> = {
  ".mp3": ["-c:a", "libmp3lame", "-b:a", "128k"],
  ".m4a": ["-c:a", "aac", "-b:a", "128k"],
  ".opus": ["-c:a", "libopus", "-b:a", "96k"],
  ".flac": ["-c:a", "flac"]
};

for (const extension of Object.keys(encoders)) {
  test(`MusicBrainz identifiers written to ${extension} files read back with Picard semantics`, async (t) => {
    if (!(await commandAvailable("ffmpeg"))) {
      t.skip("ffmpeg is required to create audio fixtures");
      return;
    }

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-mb-tags-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const audioPath = path.join(root, `track${extension}`);
    await execFileAsync("ffmpeg", [
      "-nostdin", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      ...encoders[extension],
      audioPath
    ]);

    await writeCanonicalTags(audioPath, track(audioPath, extension));
    const { common } = await parseFile(audioPath);

    assert.equal(common.title, "Canonical title");
    assert.equal(common.album, "Canonical album");
    assert.equal(common.musicbrainz_recordingid, ids.recordingId);
    assert.equal(common.musicbrainz_albumid, ids.releaseId);
    assert.equal(common.musicbrainz_releasegroupid, ids.releaseGroupId);
    assert.deepEqual(common.musicbrainz_artistid, [ids.artistId]);
    assert.deepEqual(common.musicbrainz_albumartistid, [ids.albumArtistId]);
    if (extension !== ".m4a") {
      // MP4 has no widely read release-track atom, so only ID3 and Vorbis carry it.
      assert.equal(common.musicbrainz_trackid, ids.releaseTrackId);
    }
  });
}

test("choosing Spotify metadata clears MusicBrainz identifiers left in old tags", async (t) => {
  if (!(await commandAvailable("ffmpeg"))) {
    t.skip("ffmpeg is required to create audio fixtures");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-mb-clear-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const audioPath = path.join(root, "track.flac");
  await execFileAsync("ffmpeg", [
    "-nostdin", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:a", "flac",
    "-metadata", `MUSICBRAINZ_ALBUMID=${ids.releaseId}`,
    audioPath
  ]);

  await writeCanonicalTags(audioPath, {
    ...track(audioPath, ".flac"),
    metadataConfidence: "spotify",
    identification: { status: "user-confirmed", source: "spotify", message: "Spotify", spotifyTrackId: "sp-1" }
  });
  const { common } = await parseFile(audioPath);
  assert.equal(common.musicbrainz_albumid, undefined);
});

async function commandAvailable(command: string) {
  try {
    await execFileAsync(command, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

function track(absolutePath: string, extension: string): TrackFile {
  return {
    id: "track",
    absolutePath,
    relativePath: `track${extension}`,
    extension,
    size: 0,
    mtimeMs: 0,
    artist: "Canonical artist",
    albumArtist: "Canonical album artist",
    album: "Canonical album",
    albumType: "Album",
    title: "Canonical title",
    trackNumber: 3,
    trackTotal: 12,
    discNumber: 1,
    discTotal: 1,
    year: 2024,
    duration: 1,
    isrc: null,
    bitrate: null,
    sampleRate: null,
    bitsPerSample: null,
    codec: null,
    container: null,
    lossless: false,
    duplicateKey: "",
    qualityScore: 0,
    targetPath: absolutePath,
    targetRelativePath: `track${extension}`,
    targetSource: "musicbrainz",
    metadataConfidence: "musicbrainz",
    musicbrainz: {
      recordingId: ids.recordingId,
      releaseId: ids.releaseId,
      releaseGroupId: ids.releaseGroupId,
      releaseTrackId: ids.releaseTrackId,
      artistIds: [ids.artistId],
      albumArtistIds: [ids.albumArtistId]
    },
    identification: {
      status: "user-confirmed",
      source: "musicbrainz",
      message: "Confirmed",
      recordingId: ids.recordingId,
      releaseId: ids.releaseId,
      releaseGroupId: ids.releaseGroupId
    },
    issues: []
  };
}
