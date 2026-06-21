import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TrackFile } from "../src/shared/types.js";
import { buildOrganizePlan, targetForTrack, trashOrganizeCandidate } from "../src/server/organizer.js";
import type { PrivateSettings } from "../src/server/settings.js";

const lidarrTrackFormat =
  "{Album Artist Name} - {Album Type} - {Release Year} - {Album Title}/{medium:00}{track:00} - {Track Title}";

test("imported Lidarr album type token is honored for normal albums", () => {
  const target = targetForTrack(
    track({ albumType: "Album" }),
    settings({ mode: "lidarr", standardTrackFormat: lidarrTrackFormat })
  );

  assert.equal(target.targetRelativePath, "Artist/Artist - Album - 2026 - Album Name/0103 - Track.mp3");
});

test("imported Lidarr album type token is omitted when unknown", () => {
  const target = targetForTrack(
    track({ albumType: "" }),
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

test("SpotifyBU fixed mode includes known normal album type", () => {
  const target = targetForTrack(track({ albumType: "Album" }), settings({ mode: "spotifybu" }));

  assert.equal(target.targetRelativePath, "Artist/Artist - Album - 2026 - Album Name/0103 - Track.mp3");
});

test("SpotifyBU fixed mode omits unknown album type", () => {
  const target = targetForTrack(track({ albumType: "" }), settings({ mode: "spotifybu" }));

  assert.equal(target.targetRelativePath, "Artist/Artist - 2026 - Album Name/0103 - Track.mp3");
});

test("existing literal Album folder is already organized when Lidarr template asks for album type", async () => {
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

    assert.equal(plan.summary.ready, 0);
    assert.equal(plan.summary.same, 1);
    assert.equal(plan.items[0]?.status, "same");
    assert.equal(plan.items[0]?.targetRelativePath, oldRelativePath);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("compatible Lidarr album type folder is already organized in SpotifyBU mode when local tags are missing type", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-organizer-"));

  try {
    const lidarrRelativePath = "Artist/Artist - Album - 2026 - Album Name/0103 - Track.mp3";
    const sourcePath = path.join(root, ...lidarrRelativePath.split("/"));
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "audio");

    const plan = await buildOrganizePlan(
      [
        track({
          absolutePath: sourcePath,
          relativePath: lidarrRelativePath,
          albumType: ""
        })
      ],
      settings({
        libraryPath: root,
        mode: "spotifybu"
      })
    );

    assert.equal(plan.summary.ready, 0);
    assert.equal(plan.summary.same, 1);
    assert.equal(plan.items[0]?.status, "same");
    assert.equal(plan.items[0]?.targetRelativePath, lidarrRelativePath);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("duplicate source blocked by an existing organized target does not count as a conflict", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-organizer-"));

  try {
    const targetRelativePath = "Artist/Artist - Album - 2026 - Album Name/0103 - Track.mp3";
    const sourceRelativePath = "Unsorted/Track Copy.mp3";
    const targetPath = path.join(root, ...targetRelativePath.split("/"));
    const sourcePath = path.join(root, ...sourceRelativePath.split("/"));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(targetPath, "audio-one");
    await fs.writeFile(sourcePath, "audio-two");

    const plan = await buildOrganizePlan(
      [
        track({
          id: "organized",
          absolutePath: targetPath,
          relativePath: targetRelativePath
        }),
        track({
          id: "copy",
          absolutePath: sourcePath,
          relativePath: sourceRelativePath
        })
      ],
      settings({
        libraryPath: root,
        mode: "spotifybu"
      })
    );

    assert.equal(plan.summary.conflicts, 0);
    assert.equal(plan.summary.duplicateTargets, 1);
    const duplicateItem = plan.items.find((item) => item.id === "copy");
    assert.equal(duplicateItem?.status, "duplicate-target");
    assert.equal(duplicateItem?.collision?.duplicateKeyMatches, true);
    assert.equal(duplicateItem?.collision?.candidates.length, 2);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("multiple duplicate sources for an empty target do not count as conflicts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-organizer-"));

  try {
    const firstRelativePath = "Unsorted/Track One.mp3";
    const secondRelativePath = "More/Track Two.mp3";
    const firstPath = path.join(root, ...firstRelativePath.split("/"));
    const secondPath = path.join(root, ...secondRelativePath.split("/"));
    await fs.mkdir(path.dirname(firstPath), { recursive: true });
    await fs.mkdir(path.dirname(secondPath), { recursive: true });
    await fs.writeFile(firstPath, "audio-one");
    await fs.writeFile(secondPath, "audio-two");

    const plan = await buildOrganizePlan(
      [
        track({
          id: "first-copy",
          absolutePath: firstPath,
          relativePath: firstRelativePath
        }),
        track({
          id: "second-copy",
          absolutePath: secondPath,
          relativePath: secondRelativePath
        })
      ],
      settings({
        libraryPath: root,
        mode: "spotifybu"
      })
    );

    assert.equal(plan.summary.ready, 0);
    assert.equal(plan.summary.conflicts, 0);
    assert.equal(plan.summary.duplicateTargets, 2);
    assert.deepEqual(new Set(plan.items.map((item) => item.status)), new Set(["duplicate-target"]));
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("target collisions that duplicate cleanup cannot match still count as conflicts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-organizer-"));

  try {
    const firstRelativePath = "Unsorted/Track One.mp3";
    const secondRelativePath = "More/Track Two.mp3";
    const firstPath = path.join(root, ...firstRelativePath.split("/"));
    const secondPath = path.join(root, ...secondRelativePath.split("/"));
    await fs.mkdir(path.dirname(firstPath), { recursive: true });
    await fs.mkdir(path.dirname(secondPath), { recursive: true });
    await fs.writeFile(firstPath, "audio-one");
    await fs.writeFile(secondPath, "audio-two");

    const plan = await buildOrganizePlan(
      [
        track({
          id: "short-copy",
          absolutePath: firstPath,
          relativePath: firstRelativePath,
          duration: 180
        }),
        track({
          id: "long-copy",
          absolutePath: secondPath,
          relativePath: secondRelativePath,
          duration: 240
        })
      ],
      settings({
        libraryPath: root,
        mode: "spotifybu"
      })
    );

    assert.equal(plan.summary.ready, 0);
    assert.equal(plan.summary.duplicateTargets, 0);
    assert.equal(plan.summary.conflicts, 2);
    assert.deepEqual(new Set(plan.items.map((item) => item.status)), new Set(["conflict"]));
    assert.equal(plan.items[0]?.collision?.duplicateKeyMatches, false);
    assert.equal(plan.items[0]?.collision?.candidates.length, 2);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("trashing an organize collision candidate recycles the file and refreshes the plan", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-organizer-"));

  try {
    const targetRelativePath = "Artist/Artist - Album - 2026 - Album Name/0103 - Track.mp3";
    const sourceRelativePath = "Unsorted/Track Copy.mp3";
    const targetPath = path.join(root, ...targetRelativePath.split("/"));
    const sourcePath = path.join(root, ...sourceRelativePath.split("/"));
    const testSettings = settings({
      libraryPath: root,
      mode: "spotifybu"
    });
    const tracks = [
      track({
        id: "organized",
        absolutePath: targetPath,
        relativePath: targetRelativePath,
        duration: 180,
        size: 20
      }),
      track({
        id: "copy",
        absolutePath: sourcePath,
        relativePath: sourceRelativePath,
        duration: 240,
        size: 10
      })
    ];

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(targetPath, "audio-one");
    await fs.writeFile(sourcePath, "audio-two");

    const plan = await buildOrganizePlan(tracks, testSettings);
    const sourceItem = plan.items.find((item) => item.id === "copy");
    const targetCandidate = sourceItem?.collision?.candidates.find((candidate) => candidate.trackId === "organized");

    assert.equal(sourceItem?.status, "conflict");
    assert.ok(targetCandidate);

    const result = await trashOrganizeCandidate(testSettings, tracks, "copy", targetCandidate.id);

    await assert.rejects(fs.access(targetPath), /ENOENT/);
    await fs.access(sourcePath);
    assert.equal(result.trashed, 1);
    assert.deepEqual(result.removedTrackIds, ["organized"]);
    assert.deepEqual(result.tracks.map((resultTrack) => resultTrack.id), ["copy"]);
    assert.equal(result.plan.summary.conflicts, 0);
    assert.equal(result.plan.summary.ready, 1);
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
      standardTrackFormat: "{Album Artist Name} - {Album Type} - {Release Year} - {Album Title}/{medium:00}{track:00} - {Track Title}",
      multiDiscTrackFormat: "{Album Artist Name} - {Album Type} - {Release Year} - {Album Title}/{medium:00}{track:00} - {Track Title}",
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
