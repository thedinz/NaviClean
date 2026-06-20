import fs from "node:fs/promises";
import path from "node:path";
import type { OrganizeApplyResult, OrganizePlan, OrganizePlanItem, TrackFile } from "../shared/types.js";
import type { PrivateSettings } from "./settings.js";
import { isInsidePath, toPosixRelative } from "./utils.js";

const unknownLidarrReleaseYear = "Unknown Year";
const controlCharacters = /[\u0000-\u001f]/g;
const combiningMarks = /[\u0300-\u036f]/g;
const reservedWindowsNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const lidarrBadCharacters = ["\\", "/", "<", ">", "?", "*", "|", "\""];
const lidarrReplacementCharacters = ["+", "+", "", "", "!", "-", "", ""];

export function targetForTrack(track: TrackFile, settings: PrivateSettings) {
  const root = path.resolve(settings.naming.libraryPath);
  const extension = track.extension.startsWith(".") ? track.extension : `.${track.extension}`;
  const targetRelativePath =
    settings.naming.mode === "spotifybu"
      ? spotifyBuRelativePath(track, extension)
      : templateRelativePath(track, settings, extension);
  const target = path.resolve(root, ...targetRelativePath.split("/").filter(Boolean));

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

function spotifyBuRelativePath(track: TrackFile, extension: string) {
  const artistFolderName = buildLidarrArtistFolderName(track);
  const albumFolderName = buildLidarrAlbumFolderName(track, artistFolderName);
  return path.posix.join(artistFolderName, albumFolderName, `${buildNavidromeTrackFileBase(track)}${extension}`);
}

function templateRelativePath(track: TrackFile, settings: PrivateSettings, extension: string) {
  const tokens = toTemplateTokens(track);
  const artistFormat = settings.naming.artistFolderFormat || "{Artist Name}";
  const trackFormat = selectTrackFormat(track, settings);
  const renderedArtist = renderTemplate(artistFormat, tokens);
  const renderedTrack = renderTemplate(trackFormat, tokens);
  const segments = [
    ...pathSegmentsFromTemplate(renderedArtist, settings.naming),
    ...pathSegmentsFromTemplate(renderedTrack, settings.naming)
  ];
  const filename = segments.pop() || "Unknown Track";
  return path.posix.join(...segments, `${filename}${extension}`);
}

function selectTrackFormat(track: TrackFile, settings: PrivateSettings) {
  const isMultiDisc =
    (typeof track.discTotal === "number" && track.discTotal > 1) ||
    (typeof track.discNumber === "number" && track.discNumber > 1);

  if (isMultiDisc && settings.naming.multiDiscTrackFormat) {
    return settings.naming.multiDiscTrackFormat;
  }

  return settings.naming.standardTrackFormat || "{track:00} - {Track Title}";
}

function toTemplateTokens(track: TrackFile) {
  const artist = track.artist || track.albumArtist || "Unknown Artist";
  const albumArtist = track.albumArtist || artist;
  const album = track.album || "Unknown Album";
  const title = track.title || "Unknown Track";
  const trackNumber = track.trackNumber ?? 0;
  const mediumNumber = track.discNumber ?? 1;
  const qualityTitle = qualityTitleForTrack(track);
  const originalFilename = path.parse(track.relativePath || track.absolutePath).name;

  return {
    "albumartistname": albumArtist,
    "artistname": albumArtist,
    "artistcleanname": cleanTitleToken(albumArtist),
    "artistnamethe": titleThe(albumArtist),
    "artistcleannamethe": cleanTitleToken(titleThe(albumArtist)),
    "albumtitle": album,
    "albumcleantitle": cleanTitleToken(album),
    "albumtitlethe": titleThe(album),
    "albumcleantitlethe": cleanTitleToken(titleThe(album)),
    "albumtype": lidarrAlbumType(track),
    "tracktitle": title,
    "trackcleantitle": cleanTitleToken(title),
    "trackartistname": artist,
    "trackartistmbid": "",
    "track": String(trackNumber),
    "medium": String(mediumNumber),
    "mediumformat": "CD",
    "releaseyear": releaseYear(track),
    "originaltitle": title,
    "originalfilename": originalFilename,
    "qualitytitle": qualityTitle,
    "qualityfull": qualityTitle,
    "qualityproper": "",
    "customformats": "",
    "preferredwords": "",
    "releasegroup": "",
    "mediainfoaudiocodec": track.codec || track.container || "",
    "mediainfoaudiobitrate": track.bitrate ? `${Math.round(track.bitrate / 1000)}kbps` : "",
    "mediainfoaudiochannels": "",
    "mediainfoaudiobitspersample": track.bitsPerSample ? String(track.bitsPerSample) : "",
    "mediainfoaudiosamplerate": track.sampleRate ? String(track.sampleRate) : ""
  } satisfies Record<string, string>;
}

function renderTemplate(template: string, tokens: Record<string, string>) {
  const rendered = template.replace(/\{([^{}]+)}/g, (_match, rawToken: string) => {
    const { key, format, prefix, suffix } = parseTemplateToken(rawToken);
    const value = formatTokenValue(tokens[key] ?? "", format);

    if (!value) {
      return "";
    }

    return `${prefix}${tokenValueForPath(value)}${suffix}`;
  });

  return cleanupRenderedTemplate(rendered);
}

function parseTemplateToken(rawToken: string) {
  const trimmed = rawToken.trim();
  const optional = trimmed.match(/^([([_])(.+?)([)\]_])$/);
  const prefix = optional?.[1] || "";
  const suffix = optional?.[3] || "";
  const body = optional?.[2] || trimmed;
  const separator = body.indexOf(":");
  const name = separator >= 0 ? body.slice(0, separator) : body;
  const format = separator >= 0 ? body.slice(separator + 1) : "";

  return {
    key: normalizeTemplateTokenName(name),
    format,
    prefix,
    suffix
  };
}

function normalizeTemplateTokenName(value: string) {
  return value.toLowerCase().replace(/[\s._-]+/g, "");
}

function formatTokenValue(value: string, format: string) {
  if (!format) {
    return value;
  }

  if (/^0+$/.test(format) && /^\d+$/.test(value)) {
    return value.padStart(format.length, "0");
  }

  const truncate = Number.parseInt(format, 10);
  if (Number.isFinite(truncate) && truncate !== 0) {
    return truncate > 0 ? value.slice(0, truncate) : value.slice(truncate);
  }

  return value;
}

function tokenValueForPath(value: string) {
  return value.replace(/[\\/]+/g, " ").replace(/\s+/g, " ").trim();
}

function cleanupRenderedTemplate(value: string) {
  return value
    .split(/([\\/]+)/)
    .map((part, index) => (index % 2 === 0 ? cleanupRenderedTemplateSegment(part) : part))
    .join("");
}

function cleanupRenderedTemplateSegment(value: string) {
  let segment = value;
  let previous = "";

  while (segment !== previous) {
    previous = segment;
    segment = segment.replace(/\s+-\s+-\s+/g, " - ");
  }

  return segment
    .replace(/^\s*-\s+/, "")
    .replace(/\s+-\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pathSegmentsFromTemplate(value: string, naming: PrivateSettings["naming"]) {
  return value
    .split(/[\\/]+/)
    .map((segment) => sanitizeTemplateSegment(segment, naming))
    .filter(Boolean);
}

function sanitizeTemplateSegment(value: string, naming: PrivateSettings["naming"]) {
  let segment = value.normalize("NFKD").replace(combiningMarks, "").replace(/\s+/g, " ").trim();
  segment = replaceLidarrColon(segment, naming);

  for (let index = 0; index < lidarrBadCharacters.length; index += 1) {
    segment = segment.replaceAll(
      lidarrBadCharacters[index],
      naming.replaceIllegalCharacters ? lidarrReplacementCharacters[index] : ""
    );
  }

  segment = segment.replace(controlCharacters, "").replace(/\s+/g, " ").replace(/\.+$/g, "").trim();

  if (!segment || segment === "." || segment === "..") {
    return "";
  }

  if (reservedWindowsNames.test(segment)) {
    segment = `_${segment}`;
  }

  return segment.slice(0, 180).trim();
}

function replaceLidarrColon(value: string, naming: PrivateSettings["naming"]) {
  if (!naming.replaceIllegalCharacters) {
    return value.replaceAll(":", "");
  }

  if (naming.colonReplacementFormat === 1) {
    return value.replaceAll(":", "-");
  }

  if (naming.colonReplacementFormat === 2) {
    return value.replaceAll(":", " -");
  }

  if (naming.colonReplacementFormat === 3) {
    return value.replaceAll(":", " - ");
  }

  if (naming.colonReplacementFormat === 4) {
    return value.replaceAll(": ", " - ").replaceAll(":", "-");
  }

  return value.replaceAll(":", "");
}

function cleanTitleToken(value: string) {
  return (
    value
      .normalize("NFKD")
      .replace(combiningMarks, "")
      .replace(/&/g, " and ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim() || value
  );
}

function titleThe(value: string) {
  const match = value.match(/^(the)\s+(.+)$/i);
  return match ? `${match[2]}, ${match[1]}` : value;
}

function qualityTitleForTrack(track: TrackFile) {
  const codec = (track.codec || track.container || track.extension.replace(".", "")).toUpperCase();
  const bitrate = track.bitrate ? ` ${Math.round(track.bitrate / 1000)}kbps` : "";
  const depth = track.bitsPerSample ? ` ${track.bitsPerSample}bit` : "";
  const sampleRate = track.sampleRate ? ` ${Math.round(track.sampleRate / 1000)}kHz` : "";
  return `${codec}${bitrate}${depth}${sampleRate}`.trim();
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

