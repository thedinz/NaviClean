import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { writeCanonicalTags } from "../src/server/canonical-tags.js";
import type { TrackFile } from "../src/shared/types.js";

const execFileAsync = promisify(execFile);

test("canonical retagging preserves existing identity tags while replacing descriptive tags", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-canonical-tags-"));
  const audioPath = path.join(root, "track.flac");

  try {
    await execFileAsync("ffmpeg", [
      "-nostdin", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1",
      "-c:a", "flac",
      "-metadata", "title=Wrong title",
      "-metadata", "trackkeep:track_id=tk-123",
      audioPath
    ]);

    await writeCanonicalTags(audioPath, track(audioPath));

    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format_tags",
      "-of", "json",
      audioPath
    ]);
    const parsed = JSON.parse(stdout) as { format?: { tags?: Record<string, string> } };
    const tags = Object.fromEntries(
      Object.entries(parsed.format?.tags || {}).map(([key, value]) => [key.toLowerCase(), value])
    );

    assert.equal(tags.title, "Canonical title");
    assert.equal(tags.artist, "Canonical artist");
    assert.equal(tags.album, "Canonical album");
    assert.equal(tags.album_artist, "Canonical album artist");
    assert.equal(tags.track, "3/12");
    assert.equal(tags.disc, "1/2");
    assert.equal(tags.date, "2024");
    assert.equal(tags["trackkeep:track_id"], "tk-123");
    assert.equal(tags.musicbrainz_trackid, "recording-123");
    assert.equal(tags.musicbrainz_albumid, "release-123");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function track(absolutePath: string): TrackFile {
  return {
    id: "track",
    absolutePath,
    relativePath: "track.flac",
    extension: ".flac",
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
    discTotal: 2,
    year: 2024,
    duration: 0.1,
    isrc: "USABC2400001",
    bitrate: null,
    sampleRate: null,
    bitsPerSample: null,
    codec: "flac",
    container: "flac",
    lossless: true,
    duplicateKey: "",
    qualityScore: 0,
    targetPath: absolutePath,
    targetRelativePath: "track.flac",
    targetSource: "musicbrainz",
    metadataConfidence: "musicbrainz",
    identification: {
      status: "user-confirmed",
      source: "musicbrainz",
      message: "Confirmed",
      recordingId: "recording-123",
      releaseId: "release-123"
    },
    issues: []
  };
}
