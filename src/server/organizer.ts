import fs from "node:fs/promises";
import path from "node:path";
import type { OrganizeApplyResult, OrganizePlan, OrganizePlanItem, TrackFile } from "../shared/types.js";
import type { PrivateSettings } from "./settings.js";
import { isInsidePath, sanitizePathSegment, toPosixRelative } from "./utils.js";

type TokenValues = {
  artistName: string;
  albumArtistName: string;
  albumTitle: string;
  albumType: string;
  trackTitle: string;
  trackNumber: number | null;
  mediumNumber: number | null;
  releaseYear: number | null;
};

export function targetForTrack(track: TrackFile, settings: PrivateSettings) {
  const root = path.resolve(settings.naming.libraryPath);
  const artistFormat = applyTokens(settings.naming.artistFolderFormat, toTokens(track));
  const trackFormat = applyTokens(selectTrackFormat(track, settings), toTokens(track));
  const artistSegments = toSafeSegments(artistFormat, settings.naming.replaceIllegalCharacters);
  const trackSegments = toSafeSegments(trackFormat, settings.naming.replaceIllegalCharacters);
  const extension = track.extension.startsWith(".") ? track.extension : `.${track.extension}`;
  const lastTrackSegment = trackSegments.pop() || "Unknown Track";
  const target = path.resolve(root, ...artistSegments, ...trackSegments, `${lastTrackSegment}${extension}`);

  if (!isInsidePath(root, target)) {
    return {
      targetPath: root,
      targetRelativePath: "",
      outsideLibrary: true
    };
  }

  return {
    targetPath: target,
    targetRelativePath: toPosixRelative(root, target),
    outsideLibrary: false
  };
}

export async function buildOrganizePlan(tracks: TrackFile[], settings: PrivateSettings): Promise<OrganizePlan> {
  const items: OrganizePlanItem[] = [];

  for (const track of tracks) {
    const target = targetForTrack(track, settings);
    const item: OrganizePlanItem = {
      id: track.id,
      sourcePath: track.absolutePath,
      targetPath: target.targetPath,
      sourceRelativePath: track.relativePath,
      targetRelativePath: target.targetRelativePath,
      status: "ready",
      message: "Ready"
    };

    if (target.outsideLibrary) {
      item.status = "outside-library";
      item.message = "Target leaves library root";
    } else if (path.resolve(track.absolutePath) === path.resolve(target.targetPath)) {
      item.status = "same";
      item.message = "Already organized";
    } else if (!(await pathExists(track.absolutePath))) {
      item.status = "missing-source";
      item.message = "Source file is missing";
    } else if ((await pathExists(target.targetPath)) && path.resolve(track.absolutePath) !== path.resolve(target.targetPath)) {
      item.status = "conflict";
      item.message = "Target already exists";
    }

    items.push(item);
  }

  return {
    items,
    summary: {
      ready: items.filter((item) => item.status === "ready").length,
      same: items.filter((item) => item.status === "same").length,
      conflicts: items.filter((item) => item.status === "conflict" || item.status === "outside-library").length,
      missing: items.filter((item) => item.status === "missing-source").length
    }
  };
}

export async function applyOrganizePlan(plan: OrganizePlan): Promise<OrganizeApplyResult> {
  const result: OrganizeApplyResult = {
    moved: 0,
    skipped: 0,
    errors: [],
    items: []
  };

  for (const item of plan.items) {
    if (item.status !== "ready") {
      result.skipped += 1;
      result.items.push({ ...item, applied: false });
      continue;
    }

    try {
      await fs.mkdir(path.dirname(item.targetPath), { recursive: true });
      await moveFile(item.sourcePath, item.targetPath);
      result.moved += 1;
      result.items.push({ ...item, applied: true });
    } catch (error) {
      result.errors.push(`${item.sourceRelativePath}: ${(error as Error).message}`);
      result.items.push({ ...item, applied: false });
    }
  }

  return result;
}

export function trackNeedsMove(track: TrackFile) {
  return path.resolve(track.absolutePath) !== path.resolve(track.targetPath);
}

function selectTrackFormat(track: TrackFile, settings: PrivateSettings) {
  if ((track.discTotal && track.discTotal > 1) || (track.discNumber && track.discNumber > 1)) {
    return settings.naming.multiDiscTrackFormat;
  }
  return settings.naming.standardTrackFormat;
}

function toTokens(track: TrackFile): TokenValues {
  return {
    artistName: track.albumArtist || track.artist || "Unknown Artist",
    albumArtistName: track.albumArtist || track.artist || "Unknown Artist",
    albumTitle: track.album || "Unknown Album",
    albumType: track.albumType || "Album",
    trackTitle: track.title || "Unknown Track",
    trackNumber: track.trackNumber,
    mediumNumber: track.discNumber,
    releaseYear: track.year
  };
}

function applyTokens(template: string, tokens: TokenValues) {
  return template
    .replaceAll("{Artist Name}", tokens.artistName)
    .replaceAll("{Album Artist Name}", tokens.albumArtistName)
    .replaceAll("{Album Title}", tokens.albumTitle)
    .replaceAll("{Album Type}", tokens.albumType)
    .replaceAll("{Track Title}", tokens.trackTitle)
    .replaceAll("{Release Year}", tokens.releaseYear ? String(tokens.releaseYear) : "Unknown Year")
    .replaceAll("{track:00}", padNumber(tokens.trackNumber))
    .replaceAll("{track}", tokens.trackNumber ? String(tokens.trackNumber) : "")
    .replaceAll("{medium:00}", padNumber(tokens.mediumNumber ?? 1))
    .replaceAll("{medium}", String(tokens.mediumNumber ?? 1));
}

function padNumber(value: number | null) {
  return value ? String(value).padStart(2, "0") : "00";
}

function toSafeSegments(value: string, replaceIllegalCharacters: boolean) {
  return value
    .split(/[\\/]+/)
    .map((segment) => sanitizePathSegment(segment, replaceIllegalCharacters))
    .filter(Boolean);
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function moveFile(source: string, target: string) {
  try {
    await fs.rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }

    const stat = await fs.stat(source);
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    await fs.chmod(target, stat.mode);
    await fs.utimes(target, stat.atime, stat.mtime);
    await fs.unlink(source);
  }
}

