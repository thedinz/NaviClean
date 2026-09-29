import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  RecycleBinDeleteResult,
  RecycleBinItem,
  RecycleBinRestoreResult,
  RecycleBinView
} from "../shared/types.js";
import { moveFileNoOverwrite, pruneEmptyDirectories, safeRecycleBinPath } from "./file-ops.js";
import type { PrivateSettings } from "./settings.js";
import { isInsidePath, sha1, toPosixRelative } from "./utils.js";

type RecycleBinEntry = {
  absolutePath: string;
  itemType: RecycleBinItem["itemType"];
  mtimeMs: number;
  size: number;
};

export async function listRecycleBin(settings: PrivateSettings): Promise<RecycleBinView> {
  const recycleBinPath = safeRecycleBinPath(settings);
  const entries = await collectRecycleBinEntries(recycleBinPath);
  const items = entries
    .map((entry) => recycleBinItemForEntry(recycleBinPath, entry))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.relativePath.localeCompare(right.relativePath));
  const totalSize = items.reduce((total, item) => total + item.size, 0);

  return {
    recycleBinPath,
    totalFiles: items.length,
    totalSize,
    items
  };
}

export async function emptyRecycleBin(settings: PrivateSettings): Promise<RecycleBinDeleteResult> {
  const before = await listRecycleBin(settings);
  const recycleBinPath = safeRecycleBinPath(settings);

  await fs.rm(recycleBinPath, { force: true, recursive: true });
  await fs.mkdir(recycleBinPath, { recursive: true });

  return {
    deletedFiles: before.totalFiles,
    deletedBytes: before.totalSize,
    errors: [],
    recycleBin: await listRecycleBin(settings)
  };
}

export async function deleteRecycleBinItems(
  settings: PrivateSettings,
  itemIds: string[]
): Promise<RecycleBinDeleteResult> {
  const recycleBinPath = safeRecycleBinPath(settings);
  const current = await listRecycleBin(settings);
  const selectedIds = new Set(itemIds);
  const selectedItems = current.items.filter((item) => selectedIds.has(item.id));
  const touchedDirectories = new Set<string>();
  const errors: string[] = [];
  let deletedFiles = 0;
  let deletedBytes = 0;

  for (const item of selectedItems) {
    const itemPath = path.resolve(recycleBinPath, ...item.relativePath.split("/").filter(Boolean));

    if (!isInsidePath(recycleBinPath, itemPath) || itemPath === recycleBinPath) {
      errors.push(`${item.relativePath}: path is outside the recycle bin`);
      continue;
    }

    try {
      await fs.rm(itemPath, { force: false, recursive: item.itemType === "folder" });
      touchedDirectories.add(path.dirname(itemPath));
      deletedFiles += 1;
      deletedBytes += item.size;
    } catch (error) {
      errors.push(`${item.relativePath}: ${(error as Error).message}`);
    }
  }

  for (const directory of touchedDirectories) {
    await pruneEmptyDirectories(recycleBinPath, directory);
  }

  const missingIds = itemIds.filter((id) => !current.items.some((item) => item.id === id));

  for (const id of missingIds) {
    errors.push(`${id}: item is no longer in the recycle bin`);
  }

  return {
    deletedFiles,
    deletedBytes,
    errors,
    recycleBin: await listRecycleBin(settings)
  };
}

export async function restoreRecycleBinItems(
  settings: PrivateSettings,
  itemIds: string[]
): Promise<RecycleBinRestoreResult> {
  const recycleBinPath = safeRecycleBinPath(settings);
  const libraryPath = path.resolve(settings.naming.libraryPath);
  const current = await listRecycleBin(settings);
  const selectedIds = new Set(itemIds);
  const selectedItems = current.items.filter((item) => selectedIds.has(item.id));
  const touchedDirectories = new Set<string>();
  const errors: string[] = [];
  let restoredFiles = 0;
  let restoredBytes = 0;

  for (const item of selectedItems) {
    const itemPath = path.resolve(recycleBinPath, ...item.relativePath.split("/").filter(Boolean));
    const targetPath = path.resolve(libraryPath, ...item.originalRelativePath.split("/").filter(Boolean));

    if (!isInsidePath(recycleBinPath, itemPath) || itemPath === recycleBinPath) {
      errors.push(`${item.relativePath}: path is outside the recycle bin`);
      continue;
    }

    if (!isInsidePath(libraryPath, targetPath) || targetPath === libraryPath) {
      errors.push(`${item.originalRelativePath}: restore target is outside the configured library`);
      continue;
    }

    try {
      await fs.access(targetPath);
      errors.push(`${item.originalRelativePath}: restore target already exists`);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        errors.push(`${item.originalRelativePath}: ${(error as Error).message}`);
        continue;
      }
    }

    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await moveEntry(itemPath, targetPath);
      touchedDirectories.add(path.dirname(itemPath));
      restoredFiles += 1;
      restoredBytes += item.size;
    } catch (error) {
      errors.push(`${item.originalRelativePath}: ${(error as Error).message}`);
    }
  }

  for (const directory of touchedDirectories) {
    await pruneEmptyDirectories(recycleBinPath, directory);
  }

  const missingIds = itemIds.filter((id) => !current.items.some((item) => item.id === id));

  for (const id of missingIds) {
    errors.push(`${id}: item is no longer in the recycle bin`);
  }

  return {
    restoredFiles,
    restoredBytes,
    errors,
    recycleBin: await listRecycleBin(settings)
  };
}

async function collectRecycleBinEntries(root: string) {
  const entries: RecycleBinEntry[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    let directoryEntries: Dirent[];

    try {
      directoryEntries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }

      throw new Error(`Unable to read recycle bin ${current}: ${(error as Error).message}`);
    }

    if (current !== root && directoryEntries.length === 0) {
      const relativePath = toPosixRelative(root, current);
      const segments = relativePath.split("/").filter(Boolean);

      if (segments.length > 1) {
        const stat = await fs.stat(current);
        entries.push({
          absolutePath: current,
          itemType: "folder",
          size: 0,
          mtimeMs: stat.mtimeMs
        });
      }
      continue;
    }

    for (const entry of directoryEntries) {
      const absolutePath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const stat = await fs.stat(absolutePath);
      entries.push({
        absolutePath,
        itemType: "file",
        size: stat.size,
        mtimeMs: stat.mtimeMs
      });
    }
  }

  return entries;
}

function recycleBinItemForEntry(root: string, entry: RecycleBinEntry): RecycleBinItem {
  const absolutePath = entry.absolutePath;
  const relativePath = toPosixRelative(root, absolutePath);
  const segments = relativePath.split("/").filter(Boolean);
  const deletedGroup = segments[0] || "";
  const originalRelativePath = segments.length > 1 ? segments.slice(1).join("/") : relativePath;

  return {
    id: sha1(`${entry.itemType}:${relativePath}`),
    itemType: entry.itemType,
    relativePath,
    originalRelativePath,
    deletedGroup,
    deletedAt: parseRecycleBinGroupDate(deletedGroup),
    extension: path.extname(absolutePath).toLowerCase(),
    size: entry.size,
    mtimeMs: entry.mtimeMs
  };
}

function parseRecycleBinGroupDate(value: string) {
  const match = value.match(
    /^(?<date>\d{4}-\d{2}-\d{2})T(?<hour>\d{2})-(?<minute>\d{2})-(?<second>\d{2})(?:-(?<ms>\d{3}))?Z$/
  );

  if (!match?.groups) {
    return null;
  }

  const parsed = new Date(
    `${match.groups.date}T${match.groups.hour}:${match.groups.minute}:${match.groups.second}.${match.groups.ms || "000"}Z`
  );

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function moveEntry(source: string, target: string) {
  const stat = await fs.stat(source);

  if (!stat.isDirectory()) {
    await moveFileNoOverwrite(source, target);
    return;
  }

  // Only empty folders are listed as recycle-bin folder items.
  await fs.mkdir(target);

  try {
    await fs.rmdir(source);
  } catch (error) {
    await fs.rmdir(target).catch(() => undefined);
    throw error;
  }

  await fs.chmod(target, stat.mode);
  await fs.utimes(target, stat.atime, stat.mtime);
}
