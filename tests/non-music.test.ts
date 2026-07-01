import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listNonMusicFiles, trashNonMusicFileGroups } from "../src/server/non-music.js";
import type { PrivateSettings } from "../src/server/settings.js";

test("non-music inventory groups sidecars and ignores NaviClean folders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-non-music-"));

  try {
    await writeFile(root, "Artist/Album/01 - Song.mp3", "audio");
    await writeFile(root, "Artist/Album/cover.jpg", "image");
    await writeFile(root, "Artist/Album/.DS_Store", "junk");
    await writeFile(root, "Artist/Album/notes.txt", "notes");
    await writeFile(root, "Artist/Album/booklet.pdf", "booklet");
    await writeFile(root, ".naviclean/tmp/provider-downloads/temp.part", "ignored");
    await writeFile(root, ".naviclean-trash/batch/old.nfo", "ignored");

    const view = await listNonMusicFiles(settings(root));
    const groups = new Map(view.groups.map((group) => [group.key, group]));

    assert.equal(view.totalFiles, 5);
    assert.equal(view.audioFiles, 1);
    assert.equal(view.nonMusicFiles, 4);
    assert.equal(groups.get(".jpg")?.classification, "useful");
    assert.equal(groups.get(".ds_store")?.classification, "junk");
    assert.equal(groups.get(".txt")?.classification, "review");
    assert.equal(groups.get(".pdf")?.classification, "review");
    assert.ok(groups.get(".jpg")?.examples.some((example) => example.relativePath === "Artist/Album/cover.jpg"));
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("trashes selected non-music groups and refreshes inventory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-non-music-"));

  try {
    await writeFile(root, "Artist/Album/01 - Song.mp3", "audio");
    await writeFile(root, "Artist/Album/album.nfo", "metadata");
    await writeFile(root, "Artist/Album/cover.jpg", "image");

    const result = await trashNonMusicFileGroups(settings(root), [".nfo"]);

    assert.equal(result.trashed, 1);
    assert.equal(result.trashedBytes, 8);
    assert.deepEqual(result.errors, []);
    await assert.rejects(fs.access(path.join(root, "Artist", "Album", "album.nfo")), /ENOENT/);

    const trashedFiles = await findFiles(path.join(root, ".naviclean-trash"));
    assert.deepEqual(trashedFiles.map((file) => file.replace(/^[^/]+\//, "")), ["Artist/Album/album.nfo"]);
    assert.equal(result.nonMusicFiles.groups.some((group) => group.key === ".nfo"), false);
    assert.equal(result.nonMusicFiles.groups.some((group) => group.key === ".jpg"), true);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

async function writeFile(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

async function findFiles(root: string) {
  const files: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        stack.push(absolutePath);
      } else if (entry.isFile()) {
        files.push(path.relative(root, absolutePath).split(path.sep).join("/"));
      }
    }
  }

  return files.sort();
}

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
      standardTrackFormat:
        "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {track:00} - {Track Title}",
      multiDiscTrackFormat:
        "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {medium:00}-{track:00} - {Track Title}",
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
