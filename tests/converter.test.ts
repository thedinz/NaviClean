import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { TrackFile } from "../src/shared/types.js";
import {
  buildAudioConvertView,
  parseFfmpegProgress,
  targetExtensionForAudioConvertFormat
} from "../src/server/converter.js";
import type { PrivateSettings } from "../src/server/settings.js";

test("converter groups catalog tracks by detected extension", () => {
  const view = buildAudioConvertView(settings("/music"), [
    track({ extension: ".flac", relativePath: "Artist/Album/B.flac", size: 200 }),
    track({ extension: ".m4a", relativePath: "Artist/Album/A.m4a", size: 100 }),
    track({ extension: ".m4a", relativePath: "Artist/Album/C.m4a", size: 300 })
  ]);

  assert.equal(view.libraryPath, path.resolve("/music"));
  assert.equal(view.totalFiles, 3);
  assert.equal(view.totalSize, 600);
  assert.deepEqual(
    view.groups.map((group) => [group.extension, group.count, group.totalSize]),
    [
      [".m4a", 2, 400],
      [".flac", 1, 200]
    ]
  );
  assert.deepEqual(
    view.groups[0]?.files.map((file) => file.relativePath),
    ["Artist/Album/A.m4a", "Artist/Album/C.m4a"]
  );
});

test("converter parses ffmpeg progress output", () => {
  assert.equal(parseFfmpegProgress("out_time_us=30000000\nprogress=continue\n", 60), 50);
  assert.equal(parseFfmpegProgress("out_time=00:01:30.00\nprogress=continue\n", 180), 50);
  assert.equal(parseFfmpegProgress("progress=end\n", 180), 100);
  assert.equal(parseFfmpegProgress("out_time_us=30000000\n", null), null);
});

test("converter exposes common target extensions", () => {
  assert.equal(targetExtensionForAudioConvertFormat("mp3"), ".mp3");
  assert.equal(targetExtensionForAudioConvertFormat("m4a"), ".m4a");
  assert.equal(targetExtensionForAudioConvertFormat("flac"), ".flac");
});

function track(partial: Partial<TrackFile>): TrackFile {
  return {
    absolutePath: `/music/${partial.relativePath || "Artist/Album/Track.mp3"}`,
    album: "Album",
    albumArtist: "Artist",
    albumType: "Album",
    artist: "Artist",
    bitrate: 256_000,
    bitsPerSample: null,
    codec: "AAC",
    container: "M4A",
    discNumber: null,
    discTotal: null,
    duplicateKey: "duplicate-key",
    duration: 180,
    extension: ".m4a",
    id: partial.relativePath || "track-id",
    issues: [],
    lossless: false,
    mtimeMs: 1,
    qualityScore: 1,
    relativePath: "Artist/Album/Track.m4a",
    sampleRate: 44_100,
    size: 100,
    targetPath: "",
    targetRelativePath: "",
    title: "Track",
    trackNumber: 1,
    trackTotal: null,
    year: 2026,
    ...partial
  };
}

function settings(libraryPath: string): PrivateSettings {
  return {
    auth: {
      enabled: false,
      passwordHash: "",
      username: "admin"
    },
    catalog: {
      discovery: {
        requestsPerMinute: 40
      },
      providers: {
        maxConcurrentDownloads: 1
      },
      spotify: {
        clientId: "",
        clientSecret: "",
        market: "US"
      }
    },
    cleanup: {
      emptyFolderExclusions: []
    },
    naming: {
      artistFolderFormat: "",
      colonReplacementFormat: 4,
      libraryPath,
      mode: "standard",
      multiDiscTrackFormat: "",
      recycleBinPath: `${libraryPath}/.naviclean-trash`,
      replaceIllegalCharacters: true,
      standardTrackFormat: ""
    },
    navidrome: {
      baseUrl: "",
      password: "",
      username: ""
    },
    scan: {
      autoScanEnabled: false,
      autoScanTime: "02:00",
      extensions: [".flac", ".m4a", ".mp3"]
    }
  };
}
