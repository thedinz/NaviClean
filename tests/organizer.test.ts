import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TrackFile } from "../src/shared/types.js";
import { buildOrganizePlan, targetForTrack } from "../src/server/organizer.js";
import type { PrivateSettings } from "../src/server/settings.js";

const lidarrTrackFormat =
  "{Album Artist Name} - {Album Type} - {Release Year} - {Album Title}/{medium:00}{track:00} - {Track Title}";

test("imported Lidarr album type token is empty for normal albums", () => {
  const target = targetForTrack(
    track({ albumType: "Album" }),
    settings({ mode: "lidarr", standardTrackFormat: lidarrTrackFormat })
  );

  assert.equal(target.targetRelativePath, "Artist/Artist - 2026 - Album Name/0103 - Track.mp3");
});

test("imported Lidarr album type token keeps meaningful album types", () => {
  const target = targetForTrack(
    track({ albumType: "single", trackTotal: 5 }),
    settings({ mode: "lidarr", standardTrackFormat: lidarrTrackFormat })
  );

  assert.equal(target.targetRelativePath, "Artist/Artist - EP - 2026 - Album Name/0103 - Track.mp3");
});

test("existing literal Album folder plans a move to the cleaned Lidarr path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-organizer-"));

  try {
    const oldRelativePath = "Artist/Artist - Album - 2026 - Album Name/0103 - Track.mp3";
    const sourcePath = path.join(root, ...oldRelativePath.split("/"));
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "audio");

    const plan = await buildOrganizePlan(
      [
        track({
          absolutePath: sourcePath,
          relativePath: oldRelativePath,
          albumType: "Album"
        })
      ],
      settings({
        libraryPath: root,
        mode: "lidarr",
        standardTrackFormat: lidarrTrackFormat
      })
    );

    assert.equal(plan.summary.ready, 1);
    assert.equal(plan.items[0]?.status, "ready");
    assert.equal(plan.items[0]?.targetRelativePath, "Artist/Artist - 2026 - Album Name/0103 - Track.mp3");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

function settings(overrides: Partial<PrivateSettings["naming"]> = {}): PrivateSettings {
  const libraryPath = overrides.libraryPath ?? path.resolve("C:/music");

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
    naming: {
      mode: "spotifybu",
      libraryPath,
      recycleBinPath: path.join(libraryPath, ".naviclean-trash"),
      artistFolderFormat: "{Album Artist Name}",
      standardTrackFormat: "{Album Artist Name} - {Release Year} - {Album Title}/{medium:00}{track:00} - {Track Title}",
      multiDiscTrackFormat: "{Album Artist Name} - {Release Year} - {Album Title}/{medium:00}{track:00} - {Track Title}",
      replaceIllegalCharacters: true,
      colonReplacementFormat: 4,
      lidarr: {
        baseUrl: "",
        apiKey: ""
      },
      ...overrides
    },
    scan: {
      extensions: [".mp3"]
    }
  };
}

function track(overrides: Partial<TrackFile> = {}): TrackFile {
  return {
    id: "track-1",
    absolutePath: "C:/music/Artist/old.mp3",
    relativePath: "Artist/old.mp3",
    extension: ".mp3",
    size: 1,
    mtimeMs: 1,
    artist: "Artist",
    albumArtist: "Artist",
    album: "Album Name",
    albumType: "Album",
    title: "Track",
    trackNumber: 3,
    trackTotal: 10,
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
