import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TrackFile } from "../src/shared/types.js";
import { buildOrganizePlan, targetForTrack, trashOrganizeCandidate, trashOrganizeCandidates } from "../src/server/organizer.js";
import type { PrivateSettings } from "../src/server/settings.js";

const standardTrackFormat =
  "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {track:00} - {Track Title}";
const standardMultiDiscTrackFormat =
  "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {medium:00}-{track:00} - {Track Title}";

test("standard mode uses the clean artist album year layout", () => {
  const target = targetForTrack(track(), settings({ mode: "standard" }));

  assert.equal(
    target.targetRelativePath,
    "Artist/Artist - Album Name (2026)/Artist - Album Name (2026) - 03 - Track.mp3"
  );
});

test("standard mode includes disc number for multi-disc albums", () => {
  const target = targetForTrack(track({ discNumber: 2, discTotal: 2 }), settings({ mode: "standard" }));

  assert.equal(
    target.targetRelativePath,
    "Artist/Artist - Album Name (2026)/Artist - Album Name (2026) - 02-03 - Track.mp3"
  );
});

test("manual mode honors custom tokens", () => {
  const target = targetForTrack(
    track({ albumType: "single", trackTotal: 5 }),
    settings({
      mode: "manual",
      standardTrackFormat: "{Album Artist Name}/{Album Type} - {Album Title}/{track:00} - {Track Title}"
    })
  );

  assert.equal(target.targetRelativePath, "Artist/Artist/EP - Album Name/03 - Track.mp3");
});

test("compatible standard folder is already organized when local year differs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-organizer-"));

  try {
    const standardRelativePath = "Artist/Artist - Album Name (2026)/Artist - Album Name (2026) - 03 - Track.mp3";
    const sourcePath = path.join(root, ...standardRelativePath.split("/"));
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "audio");

    const plan = await buildOrganizePlan(
      [
        track({
          absolutePath: sourcePath,
          relativePath: standardRelativePath,
          year: 2025
        })
      ],
      settings({
        libraryPath: root,
        mode: "standard"
      })
    );

    assert.equal(plan.summary.ready, 0);
    assert.equal(plan.summary.same, 1);
    assert.equal(plan.items[0]?.status, "same");
    assert.equal(plan.items[0]?.targetRelativePath, standardRelativePath);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("duplicate source blocked by an existing organized target does not count as a conflict", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-organizer-"));

  try {
    const targetRelativePath = "Artist/Artist - Album Name (2026)/Artist - Album Name (2026) - 03 - Track.mp3";
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
        mode: "standard"
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
        mode: "standard"
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
        mode: "standard"
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
    const targetRelativePath = "Artist/Artist - Album Name (2026)/Artist - Album Name (2026) - 03 - Track.mp3";
    const sourceRelativePath = "Unsorted/Track Copy.mp3";
    const targetPath = path.join(root, ...targetRelativePath.split("/"));
    const sourcePath = path.join(root, ...sourceRelativePath.split("/"));
    const testSettings = settings({
      libraryPath: root,
      mode: "standard"
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
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tracks.map((resultTrack) => resultTrack.id), ["copy"]);
    assert.equal(result.plan.summary.conflicts, 0);
    assert.equal(result.plan.summary.ready, 1);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("trashing multiple organize collision candidates recycles them in one plan refresh", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-organizer-"));

  try {
    const testSettings = settings({
      libraryPath: root,
      mode: "standard"
    });
    const firstTargetRelativePath = "Artist/Artist - Album Name (2026)/Artist - Album Name (2026) - 03 - Track.mp3";
    const firstSourceRelativePath = "Unsorted/Track Copy.mp3";
    const secondTargetRelativePath = "Artist/Artist - Album Name (2026)/Artist - Album Name (2026) - 04 - Other Track.mp3";
    const secondSourceRelativePath = "Unsorted/Other Track Copy.mp3";
    const firstTargetPath = path.join(root, ...firstTargetRelativePath.split("/"));
    const firstSourcePath = path.join(root, ...firstSourceRelativePath.split("/"));
    const secondTargetPath = path.join(root, ...secondTargetRelativePath.split("/"));
    const secondSourcePath = path.join(root, ...secondSourceRelativePath.split("/"));
    const tracks = [
      track({
        id: "organized-one",
        absolutePath: firstTargetPath,
        relativePath: firstTargetRelativePath,
        duration: 180,
        size: 20
      }),
      track({
        id: "copy-one",
        absolutePath: firstSourcePath,
        relativePath: firstSourceRelativePath,
        duration: 240,
        size: 10
      }),
      track({
        id: "organized-two",
        absolutePath: secondTargetPath,
        relativePath: secondTargetRelativePath,
        title: "Other Track",
        trackNumber: 4,
        duration: 180,
        size: 30
      }),
      track({
        id: "copy-two",
        absolutePath: secondSourcePath,
        relativePath: secondSourceRelativePath,
        title: "Other Track",
        trackNumber: 4,
        duration: 240,
        size: 15
      })
    ];

    for (const filePath of [firstTargetPath, firstSourcePath, secondTargetPath, secondSourcePath]) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, path.basename(filePath));
    }

    const plan = await buildOrganizePlan(tracks, testSettings);
    const firstSourceItem = plan.items.find((item) => item.id === "copy-one");
    const firstTargetCandidate = firstSourceItem?.collision?.candidates.find((candidate) => candidate.trackId === "organized-one");
    const secondSourceItem = plan.items.find((item) => item.id === "copy-two");
    const secondTargetCandidate = secondSourceItem?.collision?.candidates.find((candidate) => candidate.trackId === "organized-two");

    assert.equal(plan.summary.conflicts, 2);
    assert.ok(firstTargetCandidate);
    assert.ok(secondTargetCandidate);

    const result = await trashOrganizeCandidates(testSettings, tracks, [
      { itemId: "copy-one", candidateId: firstTargetCandidate.id },
      { itemId: "copy-two", candidateId: secondTargetCandidate.id }
    ]);

    await assert.rejects(fs.access(firstTargetPath), /ENOENT/);
    await assert.rejects(fs.access(secondTargetPath), /ENOENT/);
    await fs.access(firstSourcePath);
    await fs.access(secondSourcePath);
    assert.equal(result.trashed, 2);
    assert.deepEqual(new Set(result.removedTrackIds), new Set(["organized-one", "organized-two"]));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tracks.map((resultTrack) => resultTrack.id), ["copy-one", "copy-two"]);
    assert.equal(result.plan.summary.conflicts, 0);
    assert.equal(result.plan.summary.ready, 2);
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
      mode: "standard",
      libraryPath,
      recycleBinPath: path.join(libraryPath, ".naviclean-trash"),
      artistFolderFormat: "{Album Artist Name}",
      standardTrackFormat,
      multiDiscTrackFormat: standardMultiDiscTrackFormat,
      replaceIllegalCharacters: true,
      colonReplacementFormat: 4,
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
