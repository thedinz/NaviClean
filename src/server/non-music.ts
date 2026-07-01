import { constants, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  NonMusicFileClassification,
  NonMusicFileExample,
  NonMusicFileGroup,
  NonMusicFilesView,
  NonMusicTrashResult
} from "../shared/types.js";
import type { PrivateSettings } from "./settings.js";
import { isInsidePath, toPosixRelative } from "./utils.js";

type MutableNonMusicGroup = NonMusicFileGroup & {
  examples: NonMusicFileExample[];
};

type NonMusicFileCandidate = {
  absolutePath: string;
  extension: string;
  filename: string;
  groupKey: string;
  mtimeMs: number;
  relativePath: string;
  size: number;
};

type ScannedLibraryFile = {
  absolutePath: string;
  extension: string;
  filename: string;
  isAudio: boolean;
  mtimeMs: number;
  relativePath: string;
  size: number;
};

const maxExamplesPerGroup = 8;
const artworkExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);
const playlistExtensions = new Set([".m3u", ".m3u8", ".pls", ".xspf"]);
const lyricsExtensions = new Set([".lrc"]);
const textExtensions = new Set([".txt"]);
const reviewExtensions = new Set([
  ".accurip",
  ".cue",
  ".log",
  ".nfo",
  ".pdf",
  ".sfv",
  ".md5",
  ".sha1",
  ".sha256",
  ".url"
]);
const archiveExtensions = new Set([".7z", ".gz", ".rar", ".tar", ".zip"]);
const videoExtensions = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm", ".wmv"]);
const junkFilenames = new Set([".ds_store", "desktop.ini", "thumbs.db"]);
const junkExtensions = new Set([".bak", ".crdownload", ".part", ".tmp"]);

export async function listNonMusicFiles(settings: PrivateSettings): Promise<NonMusicFilesView> {
  return (await buildNonMusicInventory(settings)).view;
}

export async function trashNonMusicFileGroups(
  settings: PrivateSettings,
  groupKeys: string[]
): Promise<NonMusicTrashResult> {
  const selectedKeys = Array.from(new Set(groupKeys.map((key) => key.trim()).filter(Boolean)));

  if (selectedKeys.length === 0) {
    throw new Error("At least one non-music file group is required.");
  }

  const inventory = await buildNonMusicInventory(settings);
  const currentKeys = new Set(inventory.view.groups.map((group) => group.key));
  const selectedKeySet = new Set(selectedKeys);
  const files = inventory.files.filter((file) => selectedKeySet.has(file.groupKey));
  const libraryRoot = path.resolve(settings.naming.libraryPath);
  const trashRoot = safeRecycleBinPath(settings);
  const trashSessionRoot = path.join(trashRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  const errors = [...inventory.view.errors];
  let trashed = 0;
  let trashedBytes = 0;

  for (const key of selectedKeys) {
    if (!currentKeys.has(key)) {
      errors.push(`${key}: non-music group is no longer present`);
    }
  }

  for (const file of files) {
    const sourcePath = path.resolve(file.absolutePath);

    if (!isInsidePath(libraryRoot, sourcePath) || sourcePath === libraryRoot) {
      errors.push(`${file.relativePath}: only files inside the configured library can be recycled`);
      continue;
    }

    try {
      const targetPath = path.join(trashSessionRoot, ...file.relativePath.split("/").filter(Boolean));

      if (!isInsidePath(trashSessionRoot, targetPath) || targetPath === trashSessionRoot) {
        errors.push(`${file.relativePath}: recycle target leaves the recycle session folder`);
        continue;
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await moveFile(sourcePath, targetPath);
      trashed += 1;
      trashedBytes += file.size;
    } catch (error) {
      errors.push(`${file.relativePath}: ${(error as Error).message}`);
    }
  }

  return {
    trashed,
    trashedBytes,
    errors,
    nonMusicFiles: await listNonMusicFiles(settings)
  };
}

async function buildNonMusicInventory(settings: PrivateSettings) {
  const libraryRoot = path.resolve(settings.naming.libraryPath);
  const recycleRoot = path.resolve(settings.naming.recycleBinPath);
  const audioExtensions = new Set(settings.scan.extensions.map((extension) => extension.toLowerCase()));
  const groups = new Map<string, MutableNonMusicGroup>();
  const errors: string[] = [];
  const files: NonMusicFileCandidate[] = [];
  let totalFiles = 0;
  let audioFiles = 0;
  let nonMusicFiles = 0;
  let totalSize = 0;

  await collectNonMusicFiles(libraryRoot, libraryRoot, recycleRoot, audioExtensions, groups, errors, (file) => {
    totalFiles += 1;

    if (file.isAudio) {
      audioFiles += 1;
      return;
    }

    nonMusicFiles += 1;
    totalSize += file.size;
    files.push({
      absolutePath: file.absolutePath,
      extension: file.extension,
      filename: file.filename,
      groupKey: groupMetadata(file.filename, file.extension).key,
      mtimeMs: file.mtimeMs,
      relativePath: file.relativePath,
      size: file.size
    });
  });

  return {
    view: {
      libraryPath: libraryRoot,
      totalFiles,
      audioFiles,
      nonMusicFiles,
      totalSize,
      groups: Array.from(groups.values()).sort(compareNonMusicGroups),
      errors
    },
    files
  };
}

async function collectNonMusicFiles(
  libraryRoot: string,
  currentDirectory: string,
  recycleRoot: string,
  audioExtensions: Set<string>,
  groups: Map<string, MutableNonMusicGroup>,
  errors: string[],
  onFile: (file: ScannedLibraryFile) => void
) {
  let entries: Dirent[];

  try {
    entries = await fs.readdir(currentDirectory, { withFileTypes: true });
  } catch (error) {
    const message = `Unable to read ${currentDirectory}: ${(error as Error).message}`;

    if (currentDirectory === libraryRoot) {
      throw new Error(message);
    }

    errors.push(`${toPosixRelative(libraryRoot, currentDirectory)}: ${(error as Error).message}`);
    return;
  }

  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);

    if (entry.isDirectory()) {
      if (isIgnoredDirectory(absolutePath, entry.name, recycleRoot)) {
        continue;
      }

      await collectNonMusicFiles(libraryRoot, absolutePath, recycleRoot, audioExtensions, groups, errors, onFile);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;

    try {
      stat = await fs.stat(absolutePath);
    } catch (error) {
      errors.push(`${toPosixRelative(libraryRoot, absolutePath)}: ${(error as Error).message}`);
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    const isAudio = audioExtensions.has(extension);
    const relativePath = toPosixRelative(libraryRoot, absolutePath);

    onFile({
      absolutePath,
      extension,
      filename: entry.name,
      isAudio,
      mtimeMs: stat.mtimeMs,
      relativePath,
      size: stat.size
    });

    if (isAudio) {
      continue;
    }

    addNonMusicFile(groups, {
      extension,
      filename: entry.name,
      mtimeMs: stat.mtimeMs,
      relativePath,
      size: stat.size
    });
  }
}

function addNonMusicFile(
  groups: Map<string, MutableNonMusicGroup>,
  file: { extension: string; filename: string; mtimeMs: number; relativePath: string; size: number }
) {
  const metadata = groupMetadata(file.filename, file.extension);
  const group = groups.get(metadata.key) ?? {
    key: metadata.key,
    label: metadata.label,
    classification: metadata.classification,
    description: metadata.description,
    count: 0,
    totalSize: 0,
    examples: []
  };

  group.count += 1;
  group.totalSize += file.size;

  if (group.examples.length < maxExamplesPerGroup) {
    group.examples.push({
      relativePath: file.relativePath,
      size: file.size,
      mtimeMs: file.mtimeMs
    });
  }

  groups.set(metadata.key, group);
}

function groupMetadata(filename: string, extension: string) {
  const lowerName = filename.toLowerCase();

  if (junkFilenames.has(lowerName)) {
    return {
      key: lowerName,
      label: filename,
      classification: "junk" as NonMusicFileClassification,
      description: "OS metadata file"
    };
  }

  if (lowerName.startsWith("._")) {
    return {
      key: "._*",
      label: "AppleDouble files",
      classification: "junk" as NonMusicFileClassification,
      description: "macOS resource fork sidecars"
    };
  }

  if (artworkExtensions.has(extension)) {
    return {
      key: extension,
      label: `${extensionLabel(extension)} images`,
      classification: "useful" as NonMusicFileClassification,
      description: "Artwork sidecars used by Navidrome and other players"
    };
  }

  if (playlistExtensions.has(extension)) {
    return {
      key: extension,
      label: `${extensionLabel(extension)} playlists`,
      classification: "useful" as NonMusicFileClassification,
      description: "Playlist files Navidrome can import"
    };
  }

  if (lyricsExtensions.has(extension)) {
    return {
      key: extension,
      label: `${extensionLabel(extension)} lyrics`,
      classification: "useful" as NonMusicFileClassification,
      description: "Lyrics sidecars Navidrome can read"
    };
  }

  if (textExtensions.has(extension)) {
    return {
      key: extension,
      label: `${extensionLabel(extension)} text files`,
      classification: "review" as NonMusicFileClassification,
      description: "May be lyrics, notes, or release metadata"
    };
  }

  if (reviewExtensions.has(extension)) {
    return {
      key: extension,
      label: `${extensionLabel(extension)} metadata`,
      classification: "review" as NonMusicFileClassification,
      description: "Release, rip, cue, or checksum metadata"
    };
  }

  if (archiveExtensions.has(extension)) {
    return {
      key: extension,
      label: `${extensionLabel(extension)} archives`,
      classification: "review" as NonMusicFileClassification,
      description: "Archives inside the music library"
    };
  }

  if (videoExtensions.has(extension)) {
    return {
      key: extension,
      label: `${extensionLabel(extension)} videos`,
      classification: "review" as NonMusicFileClassification,
      description: "Video files in the music library"
    };
  }

  if (junkExtensions.has(extension)) {
    return {
      key: extension,
      label: `${extensionLabel(extension)} temporary files`,
      classification: "junk" as NonMusicFileClassification,
      description: "Temporary or partial download files"
    };
  }

  return {
    key: extension || "[none]",
    label: extension ? `${extensionLabel(extension)} files` : "No extension",
    classification: "review" as NonMusicFileClassification,
    description: "Unrecognized non-music files"
  };
}

function isIgnoredDirectory(absolutePath: string, name: string, recycleRoot: string) {
  return (
    path.resolve(absolutePath) === recycleRoot ||
    name === ".naviclean" ||
    name === ".naviclean-trash"
  );
}

function extensionLabel(extension: string) {
  return extension.replace(/^\./, "").toUpperCase() || "Unknown";
}

function compareNonMusicGroups(left: NonMusicFileGroup, right: NonMusicFileGroup) {
  const classification = classificationRank(left.classification) - classificationRank(right.classification);

  if (classification !== 0) {
    return classification;
  }

  return right.totalSize - left.totalSize || right.count - left.count || left.label.localeCompare(right.label);
}

function classificationRank(value: NonMusicFileClassification) {
  if (value === "junk") {
    return 0;
  }

  if (value === "review") {
    return 1;
  }

  return 2;
}

function safeRecycleBinPath(settings: PrivateSettings) {
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

async function moveFile(source: string, target: string) {
  try {
    await fs.rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }

    const stat = await fs.stat(source);
    await fs.copyFile(source, target, constants.COPYFILE_EXCL);
    await fs.chmod(target, stat.mode);
    await fs.utimes(target, stat.atime, stat.mtime);
    await fs.unlink(source);
  }
}
