import { parseFile } from "music-metadata";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ScanStatus, TrackFile } from "../shared/types.js";
import { saveCatalog } from "./catalog.js";
import { targetForTrack } from "./organizer.js";
import type { PrivateSettings } from "./settings.js";
import { cleanDisplayValue, normalizeForMatch, sha1, titleFromFilename, toPosixRelative } from "./utils.js";

type ProgressHandler = (status: Partial<ScanStatus>) => void;

const extensionQuality: Record<string, number> = {
  ".flac": 1000,
  ".alac": 960,
  ".wav": 920,
  ".aiff": 900,
  ".aif": 900,
  ".opus": 760,
  ".ogg": 720,
  ".m4a": 680,
  ".aac": 650,
  ".mp3": 550,
  ".wma": 420
};

export async function scanLibrary(settings: PrivateSettings, onProgress?: ProgressHandler) {
  const root = path.resolve(settings.naming.libraryPath);
  const extensions = new Set(settings.scan.extensions.map((extension) => extension.toLowerCase()));
  const recycleRoot = path.resolve(settings.naming.recycleBinPath);
  const files = await collectAudioFiles(root, extensions, recycleRoot, onProgress);
  const tracks: TrackFile[] = [];
  const errors: string[] = [];

  for (const filePath of files) {
    try {
      const track = await readTrack(filePath, root, settings);
      tracks.push(track);
    } catch (error) {
      const message = `${toPosixRelative(root, filePath)}: ${(error as Error).message}`;
      errors.push(message);
      if (errors.length > 100) {
        errors.shift();
      }
    }

    onProgress?.({
      audioFiles: tracks.length,
      errors
    });
  }

  await saveCatalog(tracks);
  return { tracks, errors };
}

async function collectAudioFiles(root: string, extensions: Set<string>, recycleRoot: string, onProgress?: ProgressHandler) {
  const files: string[] = [];
  const stack = [root];
  let scannedFiles = 0;

  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: Dirent[];

    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Unable to read ${current}: ${(error as Error).message}`);
    }

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (path.resolve(absolute) === recycleRoot || entry.name === ".naviclean-trash") {
          continue;
        }
        stack.push(absolute);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      scannedFiles += 1;
      if (extensions.has(path.extname(entry.name).toLowerCase())) {
        files.push(absolute);
      }

      if (scannedFiles % 50 === 0) {
        onProgress?.({ scannedFiles });
      }
    }
  }

  onProgress?.({ scannedFiles });
  return files;
}

async function readTrack(filePath: string, root: string, settings: PrivateSettings): Promise<TrackFile> {
  const stat = await fs.stat(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const issues: string[] = [];
  let metadata: Awaited<ReturnType<typeof parseFile>> | null = null;

  try {
    metadata = await parseFile(filePath, { duration: true });
  } catch (error) {
    issues.push(`Metadata read failed: ${(error as Error).message}`);
  }

  const common = metadata?.common;
  const format = metadata?.format;
  const artist = cleanDisplayValue(common?.artist || common?.artists?.[0], "Unknown Artist");
  const albumArtist = cleanDisplayValue(common?.albumartist || common?.artist || common?.artists?.[0], artist);
  const album = cleanDisplayValue(common?.album, "Unknown Album");
  const title = cleanDisplayValue(common?.title, titleFromFilename(filePath));
  const trackNumber = common?.track?.no || null;
  const trackTotal = common?.track?.of || null;
  const discNumber = common?.disk?.no || null;
  const discTotal = common?.disk?.of || null;
  const year = typeof common?.year === "number" ? common.year : null;
  const duration = typeof format?.duration === "number" ? format.duration : null;
  const bitrate = typeof format?.bitrate === "number" ? Math.round(format.bitrate) : null;
  const sampleRate = typeof format?.sampleRate === "number" ? format.sampleRate : null;
  const bitsPerSample = typeof format?.bitsPerSample === "number" ? format.bitsPerSample : null;
  const codec = cleanNullable(format?.codec);
  const container = cleanNullable(format?.container);
  const lossless = Boolean(format?.lossless || [".flac", ".alac", ".wav", ".aiff", ".aif"].includes(extension));

  if (artist === "Unknown Artist") {
    issues.push("Missing artist");
  }
  if (album === "Unknown Album") {
    issues.push("Missing album");
  }
  if (!trackNumber) {
    issues.push("Missing track number");
  }

  const partialTrack = {
    id: fileId(filePath, stat.size, stat.mtimeMs),
    absolutePath: filePath,
    relativePath: toPosixRelative(root, filePath),
    extension,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    artist,
    albumArtist,
    album,
    title,
    trackNumber,
    trackTotal,
    discNumber,
    discTotal,
    year,
    duration,
    bitrate,
    sampleRate,
    bitsPerSample,
    codec,
    container,
    lossless,
    duplicateKey: duplicateKey({
      artist: albumArtist || artist,
      title,
      duration,
      isrc: common?.isrc?.[0] || null
    }),
    qualityScore: qualityScore(extension, bitrate, bitsPerSample, lossless),
    targetPath: "",
    targetRelativePath: "",
    issues
  } satisfies TrackFile;

  const target = targetForTrack(partialTrack, settings);
  return {
    ...partialTrack,
    targetPath: target.targetPath,
    targetRelativePath: target.targetRelativePath
  };
}

function duplicateKey(values: { artist: string; title: string; duration: number | null; isrc: string | null }) {
  if (values.isrc) {
    return `isrc:${normalizeForMatch(values.isrc)}`;
  }

  const durationBucket = values.duration ? Math.round(values.duration / 2) * 2 : "unknown-duration";
  return [normalizeForMatch(values.artist), normalizeForMatch(values.title), durationBucket].join("|");
}

function qualityScore(extension: string, bitrate: number | null, bitsPerSample: number | null, lossless: boolean) {
  const base = extensionQuality[extension] || 100;
  const bitrateBonus = bitrate ? Math.min(240, Math.round(bitrate / 1000)) : 0;
  const bitDepthBonus = bitsPerSample ? bitsPerSample * 4 : 0;
  return base + bitrateBonus + bitDepthBonus + (lossless ? 100 : 0);
}

function fileId(filePath: string, size: number, mtimeMs: number) {
  return sha1(`${filePath}:${size}:${Math.round(mtimeMs)}`);
}

function cleanNullable(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
