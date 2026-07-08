import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { TrackFile } from "../src/shared/types.js";
import {
  buildAudioConvertView,
  formatFfmpegError,
  parseFfmpegProgress,
  selectAudioConvertTracks,
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

test("converter selects only requested files for the source format", () => {
  const tracks = [
    track({ extension: ".ogg", id: "one", relativePath: "Artist/Album/One.ogg" }),
    track({ extension: ".ogg", id: "two", relativePath: "Artist/Album/Two.ogg" }),
    track({ extension: ".mp3", id: "three", relativePath: "Artist/Album/Three.mp3" })
  ];

  assert.deepEqual(
    selectAudioConvertTracks(tracks, ".ogg", ["two"]).map((item) => item.id),
    ["two"]
  );
  assert.deepEqual(
    selectAudioConvertTracks(tracks, ".ogg").map((item) => item.id),
    ["one", "two"]
  );
});

test("converter rejects selected files outside the source format", () => {
  assert.throws(
    () => selectAudioConvertTracks([
      track({ extension: ".ogg", id: "one", relativePath: "Artist/Album/One.ogg" }),
      track({ extension: ".mp3", id: "two", relativePath: "Artist/Album/Two.mp3" })
    ], ".ogg", ["one", "two"]),
    /Some selected files are no longer available/
  );
});

test("converter explains unreadable ffmpeg source audio", () => {
  const message = formatFfmpegError(
    { code: 1, message: "ffmpeg exited with code 1" },
    [
      "[Vorbis parser @ 0x55c87529da80] Invalid Setup header",
      "[ogg @ 0x55c87529acc0] Header processing failed: Unknown error occurred",
      "/music/Doctor Flake/Track.ogg: Unknown error occurred"
    ].join("\n"),
    { sourcePath: "/music/Doctor Flake/Track.ogg" }
  );

  assert.match(message, /could not read this source audio stream/);
  assert.match(message, /not necessarily empty/);
  assert.match(message, /audio header may be damaged, incomplete, or mislabeled/);
  assert.match(message, /ffmpeg exit code: 1/);
  assert.match(message, /\[Vorbis parser\] Invalid Setup header/);
  assert.doesNotMatch(message, /0x55c87529da80/);
  assert.doesNotMatch(message, /\/music\/Doctor Flake/);
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
