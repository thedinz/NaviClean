import fs from "node:fs/promises";
import path from "node:path";
import type { OrganizeApplyResult, OrganizePlan, OrganizePlanItem, TrackFile } from "../shared/types.js";
import type { PrivateSettings } from "./settings.js";
import { isInsidePath, toPosixRelative } from "./utils.js";

const unknownLidarrReleaseYear = "Unknown Year";

export function targetForTrack(track: TrackFile, settings: PrivateSettings) {
  const root = path.resolve(settings.naming.libraryPath);
  const extension = track.extension.startsWith(".") ? track.extension : `.${track.extension}`;
  const artistFolderName = buildLidarrArtistFolderName(track);
  const albumFolderName = buildLidarrAlbumFolderName(track, artistFolderName);
  const target = path.resolve(root, artistFolderName, albumFolderName, `${buildNavidromeTrackFileBase(track)}${extension}`);

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

function buildLidarrArtistFolderName(track: TrackFile) {
  return cleanLidarrToken(track.albumArtist || track.artist || "Unknown Artist", "Unknown Artist");
}

function buildLidarrAlbumFolderName(track: TrackFile, artistFolderName = buildLidarrArtistFolderName(track)) {
  return [
    artistFolderName,
    lidarrAlbumType(track),
    releaseYear(track),
    cleanLidarrToken(track.album || "Unknown Album", "Unknown Album")
  ].join(" - ");
}

function buildNavidromeTrackFileBase(track: TrackFile) {
  const mediumNumber = track.discNumber ?? 1;
  const trackNumber = track.trackNumber ?? 0;
  const prefix = `${padLidarrNumber(mediumNumber)}${padLidarrNumber(trackNumber)}`;

  return `${prefix} - ${cleanLidarrToken(track.title || "Unknown Track", "Unknown Track")}`;
}

function cleanLidarrToken(value: string, fallback: string) {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || fallback
  );
}

function lidarrAlbumType(track: TrackFile) {
  const albumType = (track.albumType ?? "").trim().toLowerCase();

  if (albumType === "compilation") {
    return "Compilation";
  }

  if (albumType === "single") {
    return typeof track.trackTotal === "number" && track.trackTotal >= 4 && track.trackTotal <= 7 ? "EP" : "Single";
  }

  if (albumType === "ep") {
    return "EP";
  }

  return albumType ? titleCaseAlbumType(albumType) : "Album";
}

function titleCaseAlbumType(value: string) {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function releaseYear(track: TrackFile) {
  return track.year ? String(track.year) : unknownLidarrReleaseYear;
}

function padLidarrNumber(value: number) {
  return Math.max(0, Math.floor(value)).toString().padStart(2, "0");
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

