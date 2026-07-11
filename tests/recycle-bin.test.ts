import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deleteRecycleBinItems, emptyRecycleBin, listRecycleBin, restoreRecycleBinItems } from "../src/server/recycle-bin.js";
import type { PrivateSettings } from "../src/server/settings.js";

test("lists recycle bin files with original paths and totals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-trash-"));

  try {
    const recycleBinPath = path.join(root, ".naviclean-trash");
    await fs.mkdir(path.join(recycleBinPath, "2026-06-21T07-42-49-123Z", "Artist"), { recursive: true });
    await fs.writeFile(path.join(recycleBinPath, "2026-06-21T07-42-49-123Z", "Artist", "Track.mp3"), "audio");
    await fs.mkdir(path.join(recycleBinPath, "2026-06-21T07-42-49-123Z", "Artist", "Empty Album"), { recursive: true });

    const view = await listRecycleBin(settings(root));
    const fileItem = view.items.find((item) => item.originalRelativePath === "Artist/Track.mp3");
    const folderItem = view.items.find((item) => item.originalRelativePath === "Artist/Empty Album");

    assert.equal(view.recycleBinPath, path.resolve(recycleBinPath));
    assert.equal(view.totalFiles, 2);
    assert.equal(view.totalSize, 5);
    assert.equal(fileItem?.itemType, "file");
    assert.equal(fileItem?.deletedAt, "2026-06-21T07:42:49.123Z");
    assert.equal(folderItem?.itemType, "folder");
    assert.equal(folderItem?.size, 0);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("deletes selected recycle bin files and keeps unselected files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-trash-"));

  try {
    const recycleBinPath = path.join(root, ".naviclean-trash");
    const keepPath = path.join(recycleBinPath, "batch", "Keep.mp3");
    const removePath = path.join(recycleBinPath, "batch", "Remove.mp3");
    await fs.mkdir(path.dirname(keepPath), { recursive: true });
    await fs.writeFile(keepPath, "keep");
    await fs.writeFile(removePath, "remove");

    const before = await listRecycleBin(settings(root));
    const removeItem = before.items.find((item) => item.originalRelativePath === "Remove.mp3");

    assert.ok(removeItem);

    const result = await deleteRecycleBinItems(settings(root), [removeItem.id]);

    assert.equal(result.deletedFiles, 1);
    assert.equal(result.deletedBytes, 6);
    assert.deepEqual(result.errors, []);
    await fs.access(keepPath);
    await assert.rejects(fs.access(removePath), /ENOENT/);
    assert.deepEqual(result.recycleBin.items.map((item) => item.originalRelativePath), ["Keep.mp3"]);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("restores selected recycle bin files to their original library paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-trash-"));

  try {
    const recycleBinPath = path.join(root, ".naviclean-trash");
    const trashPath = path.join(recycleBinPath, "2026-06-21T07-42-49-123Z", "Artist", "Album", "info.nfo");
    const restoredPath = path.join(root, "Artist", "Album", "info.nfo");
    await fs.mkdir(path.dirname(trashPath), { recursive: true });
    await fs.writeFile(trashPath, "metadata");

    const before = await listRecycleBin(settings(root));
    const item = before.items.find((candidate) => candidate.originalRelativePath === "Artist/Album/info.nfo");

    assert.ok(item);

    const result = await restoreRecycleBinItems(settings(root), [item.id]);

    assert.equal(result.restoredFiles, 1);
    assert.equal(result.restoredBytes, 8);
    assert.deepEqual(result.errors, []);
    assert.equal(await fs.readFile(restoredPath, "utf8"), "metadata");
    await assert.rejects(fs.access(trashPath), /ENOENT/);
    assert.equal(result.recycleBin.totalFiles, 0);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("restores selected recycle bin folders to their original library paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-trash-"));

  try {
    const recycleBinPath = path.join(root, ".naviclean-trash");
    const trashPath = path.join(recycleBinPath, "2026-06-21T07-42-49-123Z", "Artist", "Empty Album");
    const restoredPath = path.join(root, "Artist", "Empty Album");
    await fs.mkdir(trashPath, { recursive: true });

    const before = await listRecycleBin(settings(root));
    const item = before.items.find((candidate) => candidate.originalRelativePath === "Artist/Empty Album");

    assert.equal(item?.itemType, "folder");

    const result = await restoreRecycleBinItems(settings(root), [item?.id || ""]);

    assert.equal(result.restoredFiles, 1);
    assert.equal(result.restoredBytes, 0);
    assert.deepEqual(result.errors, []);
    assert.equal((await fs.stat(restoredPath)).isDirectory(), true);
    await assert.rejects(fs.access(trashPath), /ENOENT/);
    assert.equal(result.recycleBin.totalFiles, 0);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("empties the recycle bin and recreates the root folder", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-trash-"));

  try {
    const recycleBinPath = path.join(root, ".naviclean-trash");
    await fs.mkdir(path.join(recycleBinPath, "batch"), { recursive: true });
    await fs.writeFile(path.join(recycleBinPath, "batch", "Track.mp3"), "audio");

    const result = await emptyRecycleBin(settings(root));

    assert.equal(result.deletedFiles, 1);
    assert.equal(result.deletedBytes, 5);
    assert.equal(result.recycleBin.totalFiles, 0);
    await fs.access(recycleBinPath);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("rejects recycle bins that contain the library path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-trash-"));

  try {
    await assert.rejects(
      listRecycleBin({
        ...settings(root),
        naming: {
          ...settings(root).naming,
          recycleBinPath: path.dirname(root)
        }
      }),
      /Recycle bin path cannot be the library path or contain the library path/
    );
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
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
        maxConcurrentDownloads: 1, opusQuality: 192, mp3FallbackEnabled: true, mp3FallbackQuality: 320
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
      extensions: [".mp3"],
      autoScanEnabled: true,
      autoScanTime: "02:00"
    },
    cleanup: {
      emptyFolderExclusions: ["provider-downloads", ".spotifybu/tmp/provider-downloads"]
    }
  };
}
