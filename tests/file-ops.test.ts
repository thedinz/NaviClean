import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRecycleSession, moveFileNoOverwrite, TargetExistsError, writeJsonAtomic } from "../src/server/file-ops.js";
import type { PrivateSettings } from "../src/server/settings.js";

test("moveFileNoOverwrite moves a file to a free target", async () => {
  await withTempDir(async (root) => {
    const source = path.join(root, "source.mp3");
    const target = path.join(root, "target.mp3");
    await fs.writeFile(source, "audio");

    await moveFileNoOverwrite(source, target);

    assert.equal(await fs.readFile(target, "utf8"), "audio");
    await assert.rejects(fs.access(source), /ENOENT/);
  });
});

test("moveFileNoOverwrite refuses to replace an existing target", async () => {
  await withTempDir(async (root) => {
    const source = path.join(root, "source.mp3");
    const target = path.join(root, "target.mp3");
    await fs.writeFile(source, "new");
    await fs.writeFile(target, "existing");

    await assert.rejects(moveFileNoOverwrite(source, target), TargetExistsError);

    assert.equal(await fs.readFile(source, "utf8"), "new");
    assert.equal(await fs.readFile(target, "utf8"), "existing");
  });
});

test("recycle session keeps the library-relative path under a timestamped folder", async () => {
  await withTempDir(async (root) => {
    const library = path.join(root, "music");
    const recycleBin = path.join(root, "trash");
    const source = path.join(library, "Artist", "Album", "01 - Track.mp3");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "audio");

    const session = createRecycleSession(settings(library, recycleBin), new Date("2026-09-27T10:11:12.345Z"));
    await session.recycle(source, "Artist/Album/01 - Track.mp3");

    const recycled = path.join(recycleBin, "2026-09-27T10-11-12-345Z", "Artist", "Album", "01 - Track.mp3");
    assert.equal(await fs.readFile(recycled, "utf8"), "audio");
    await assert.rejects(fs.access(source), /ENOENT/);
  });
});

test("recycle session rejects files outside the library and paths that escape the session", async () => {
  await withTempDir(async (root) => {
    const library = path.join(root, "music");
    const outside = path.join(root, "outside.mp3");
    const inside = path.join(library, "track.mp3");
    await fs.mkdir(library, { recursive: true });
    await fs.writeFile(outside, "audio");
    await fs.writeFile(inside, "audio");

    const session = createRecycleSession(settings(library, path.join(root, "trash")));

    await assert.rejects(session.recycle(outside, "outside.mp3"), /only files inside the configured library/);
    await assert.rejects(session.recycle(inside, "../../escape.mp3"), /leaves the recycle session folder/);
    await fs.access(outside);
    await fs.access(inside);
  });
});

test("recycle session refuses a recycle bin that contains the library", () => {
  assert.throws(
    () => createRecycleSession(settings(path.resolve("C:/data/music"), path.resolve("C:/data"))),
    /cannot be the library path or contain the library path/
  );
});

test("concurrent atomic JSON writes to one file all succeed and the last call wins", async () => {
  await withTempDir(async (root) => {
    const target = path.join(root, "store.json");

    await Promise.all(Array.from({ length: 20 }, (_, index) => writeJsonAtomic(target, { index })));

    const parsed = JSON.parse(await fs.readFile(target, "utf8")) as { index: number };
    assert.equal(parsed.index, 19);
    assert.deepEqual(await fs.readdir(root), ["store.json"]);
  });
});

async function withTempDir(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "naviclean-file-ops-"));

  try {
    await run(root);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
}

function settings(libraryPath: string, recycleBinPath: string) {
  return { naming: { libraryPath, recycleBinPath } } as PrivateSettings;
}
