import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  NonMusicFileClassification,
  NonMusicFileExample,
  NonMusicFileGroup,
  NonMusicFilesView
} from "../shared/types.js";
import type { PrivateSettings } from "./settings.js";
import { toPosixRelative } from "./utils.js";

type MutableNonMusicGroup = NonMusicFileGroup & {
  examples: NonMusicFileExample[];
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
  const libraryRoot = path.resolve(settings.naming.libraryPath);
  const recycleRoot = path.resolve(settings.naming.recycleBinPath);
  const audioExtensions = new Set(settings.scan.extensions.map((extension) => extension.toLowerCase()));
  const groups = new Map<string, MutableNonMusicGroup>();
  const errors: string[] = [];
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
  });

  return {
    libraryPath: libraryRoot,
    totalFiles,
    audioFiles,
    nonMusicFiles,
    totalSize,
    groups: Array.from(groups.values()).sort(compareNonMusicGroups),
    errors
  };
}

async function collectNonMusicFiles(
  libraryRoot: string,
  currentDirectory: string,
  recycleRoot: string,
  audioExtensions: Set<string>,
  groups: Map<string, MutableNonMusicGroup>,
  errors: string[],
  onFile: (file: { isAudio: boolean; size: number }) => void
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

    onFile({ isAudio, size: stat.size });

    if (isAudio) {
      continue;
    }

    addNonMusicFile(groups, {
      extension,
      filename: entry.name,
      mtimeMs: stat.mtimeMs,
      relativePath: toPosixRelative(libraryRoot, absolutePath),
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
