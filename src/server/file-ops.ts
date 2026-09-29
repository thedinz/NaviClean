import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { PrivateSettings } from "./settings.js";
import { isInsidePath } from "./utils.js";

// Filesystems that cannot hard link report one of these; fall back to a checked rename there.
const linkUnsupportedCodes = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK"]);

export class TargetExistsError extends Error {
  readonly code = "EEXIST";

  constructor(targetPath: string) {
    super(`Target already exists: ${targetPath}`);
  }
}

export type RecycleSession = {
  libraryRoot: string;
  sessionRoot: string;
  recycle: (sourcePath: string, relativePath: string) => Promise<void>;
};

/**
 * Moves a file without ever replacing an existing target.
 *
 * A hard link fails atomically when the target exists, so link + unlink is used where the
 * filesystem supports it. Cross-device moves copy with COPYFILE_EXCL. Filesystems without hard
 * links check the target immediately before renaming.
 */
export async function moveFileNoOverwrite(source: string, target: string) {
  try {
    await fs.link(source, target);
  } catch (error) {
    const code = errorCode(error);

    if (code === "EEXIST") {
      throw new TargetExistsError(target);
    }

    if (code === "EXDEV") {
      await copyThenUnlink(source, target);
      return;
    }

    if (!linkUnsupportedCodes.has(code)) {
      throw error;
    }

    if (await pathExists(target)) {
      throw new TargetExistsError(target);
    }

    await fs.rename(source, target);
    return;
  }

  try {
    await fs.unlink(source);
  } catch (error) {
    await fs.unlink(target).catch(() => undefined);
    throw error;
  }
}

export function safeRecycleBinPath(settings: PrivateSettings) {
  const recycleBinPath = path.resolve(settings.naming.recycleBinPath);
  const libraryPath = path.resolve(settings.naming.libraryPath);

  if (recycleBinPath === path.parse(recycleBinPath).root) {
    throw new Error("Recycle bin path cannot be a drive or filesystem root.");
  }

  if (recycleBinPath === libraryPath || isInsidePath(recycleBinPath, libraryPath)) {
    throw new Error("Recycle bin path cannot be the library path or contain the library path.");
  }

  return recycleBinPath;
}

export function recycleSessionFolderName(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Starts one timestamped recycle-bin session. Every caller that moves library files to the
 * recycle bin goes through `recycle`, so they all get the same path and overwrite checks.
 */
export function createRecycleSession(settings: PrivateSettings, now = new Date()): RecycleSession {
  const libraryRoot = path.resolve(settings.naming.libraryPath);
  const sessionRoot = path.join(safeRecycleBinPath(settings), recycleSessionFolderName(now));

  return {
    libraryRoot,
    sessionRoot,
    recycle: async (sourcePath: string, relativePath: string) => {
      const source = path.resolve(sourcePath);

      if (!isInsidePath(libraryRoot, source) || source === libraryRoot) {
        throw new Error("only files inside the configured library can be recycled");
      }

      const target = path.join(sessionRoot, ...relativePath.split(/[\\/]/).filter(Boolean));

      if (!isInsidePath(sessionRoot, target) || target === sessionRoot) {
        throw new Error("recycle target leaves the recycle session folder");
      }

      await fs.mkdir(path.dirname(target), { recursive: true });
      await moveFileNoOverwrite(source, target);
    }
  };
}

export async function pruneEmptyDirectories(root: string, startDirectory: string) {
  let current = path.resolve(startDirectory);
  const resolvedRoot = path.resolve(root);

  while (current !== resolvedRoot && isInsidePath(resolvedRoot, current)) {
    try {
      await fs.rmdir(current);
    } catch (error) {
      const code = errorCode(error);

      if (code === "ENOENT") {
        current = path.dirname(current);
        continue;
      }

      if (code === "ENOTEMPTY" || code === "EEXIST") {
        break;
      }

      throw error;
    }

    current = path.dirname(current);
  }
}

export async function pathExists(filePath: string) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function copyThenUnlink(source: string, target: string) {
  const stat = await fs.stat(source);

  try {
    await fs.copyFile(source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new TargetExistsError(target);
    }

    throw error;
  }

  await fs.chmod(target, stat.mode);
  await fs.utimes(target, stat.atime, stat.mtime);
  await fs.unlink(source);
}

function errorCode(error: unknown) {
  return String((error as NodeJS.ErrnoException)?.code ?? "");
}

const jsonWriteQueues = new Map<string, Promise<void>>();

/**
 * Writes JSON through a uniquely named temp file and renames it into place, so a crash never
 * leaves a truncated file. Writes to the same path are queued in call order, so the last call
 * always wins and concurrent renames never race.
 */
export function writeJsonAtomic(filePath: string, payload: unknown) {
  const key = path.resolve(filePath);
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const previous = jsonWriteQueues.get(key) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(() => writeFileAtomic(filePath, serialized));
  const settled = write.catch(() => undefined);

  jsonWriteQueues.set(key, settled);
  void settled.then(() => {
    if (jsonWriteQueues.get(key) === settled) {
      jsonWriteQueues.delete(key);
    }
  });

  return write;
}

async function writeFileAtomic(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;

  try {
    await fs.writeFile(tempPath, contents, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
