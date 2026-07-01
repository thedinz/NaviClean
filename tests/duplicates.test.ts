import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildDuplicateGroups, resolveSelectedDuplicates } from "../src/server/duplicates.js";
import type { PrivateSettings } from "../src/server/settings.js";
import type { TrackFile } from "../src/shared/types.js";

test("bulk duplicate cleanup recycles selected tracks across groups", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-duplicates-"));

  try {
    const firstKeepPath = path.join(root, "Artist", "Album", "0101 - One.flac");
    const firstRemovePath = path.join(root, "Artist", "Album", "0101 - One.mp3");
    const secondKeepPath = path.join(root, "Artist", "Album", "0102 - Two.flac");
    const secondRemovePath = path.join(root, "Artist", "Album", "0102 - Two.mp3");

    for (const filePath of [firstKeepPath, firstRemovePath, secondKeepPath, secondRemovePath]) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, path.basename(filePath));
    }

    const tracks = [
      track({
        id: "one-keep",
        absolutePath: firstKeepPath,
        relativePath: "Artist/Album/0101 - One.flac",
        extension: ".flac",
        title: "One",
        trackNumber: 1,
        qualityScore: 1200
      }),
      track({
        id: "one-remove",
        absolutePath: firstRemovePath,
        relativePath: "Artist/Album/0101 - One.mp3",
        extension: ".mp3",
        title: "One",
        trackNumber: 1,
        qualityScore: 600
      }),
      track({
        id: "two-keep",
        absolutePath: secondKeepPath,
        relativePath: "Artist/Album/0102 - Two.flac",
        extension: ".flac",
        title: "Two",
        trackNumber: 2,
        qualityScore: 1200
      }),
      track({
        id: "two-remove",
        absolutePath: secondRemovePath,
        relativePath: "Artist/Album/0102 - Two.mp3",
        extension: ".mp3",
        title: "Two",
        trackNumber: 2,
        qualityScore: 600
      })
    ];

    const result = await resolveSelectedDuplicates(settings(root), tracks, ["one-remove", "two-remove"]);

    assert.equal(result.trashed, 2);
    assert.deepEqual(new Set(result.removedTrackIds), new Set(["one-remove", "two-remove"]));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tracks.map((resultTrack) => resultTrack.id), ["one-keep", "two-keep"]);
    await fs.access(firstKeepPath);
    await fs.access(secondKeepPath);
    await assert.rejects(fs.access(firstRemovePath), /ENOENT/);
    await assert.rejects(fs.access(secondRemovePath), /ENOENT/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("bulk duplicate cleanup keeps at least one track in each selected group", async () => {
  const tracks = [
    track({ id: "one-keep", title: "One", trackNumber: 1 }),
    track({ id: "one-remove", title: "One", trackNumber: 1 })
  ];

  await assert.rejects(
    resolveSelectedDuplicates(settings("C:/music"), tracks, ["one-keep", "one-remove"]),
    /must keep at least one file/
  );
});

test("duplicate scan ignores same song on different releases", () => {
  const groups = buildDuplicateGroups([
    track({
      id: "album-copy",
      album: "Original Album",
      title: "Same Song",
      trackNumber: 2,
      year: 2020
    }),
    track({
      id: "best-of-copy",
      album: "Best Of",
      title: "Same Song",
      trackNumber: 7,
      year: 2024
    })
  ]);

  assert.equal(groups.length, 0);
});

function settings(libraryPath: string): PrivateSettings {
  return {
    auth: {
      enabled: true,
      username: "admin",
      passwordHash: ""
    },
    navidrome: {
      baseUrl: "",
      username: "",
      password: ""
    },
    catalog: {
      spotify: {
        clientId: "",
        clientSecret: "",
        market: "US"
      },
      providers: {
        maxConcurrentDownloads: 1
      },
      discovery: {
        requestsPerMinute: 40
      }
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
    scan: {
      extensions: [".mp3", ".flac"],
      autoScanEnabled: true,
      autoScanTime: "02:00"
    },
    cleanup: {
      emptyFolderExclusions: ["provider-downloads", ".spotifybu/tmp/provider-downloads"]
    }
  };
}

function track(overrides: Partial<TrackFile> = {}): TrackFile {
  const id = overrides.id || "track";

  return {
    id,
    absolutePath: `C:/music/${id}.mp3`,
    relativePath: `${id}.mp3`,
    extension: ".mp3",
    size: 1,
    mtimeMs: 1,
    artist: "Artist",
    albumArtist: "Artist",
    album: "Album",
    albumType: "Album",
    title: "Track",
    trackNumber: 1,
    trackTotal: 2,
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
