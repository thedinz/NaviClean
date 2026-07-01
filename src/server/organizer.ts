import fs from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import type {
  OrganizeApplyResult,
  OrganizeCollision,
  OrganizeCollisionCandidate,
  OrganizePlan,
  OrganizePlanItem,
  OrganizeTrashResult,
  OrganizeTrashSelection,
  TrackFile
} from "../shared/types.js";
import { duplicateKeyForTrack } from "./matching.js";
import { standardNamingFormatDefaults } from "./settings.js";
import type { PrivateSettings } from "./settings.js";
import { isInsidePath, toPosixRelative } from "./utils.js";

const unknownReleaseYear = "Unknown Year";
const controlCharacters = /[\u0000-\u001f]/g;
const combiningMarks = /[\u0300-\u036f]/g;
const reservedWindowsNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const unsafePathCharacters = ["\\", "/", "<", ">", "?", "*", "|", "\""];
const pathReplacementCharacters = ["+", "+", "", "", "!", "-", "", ""];

type PlannedOrganizeItem = {
  item: OrganizePlanItem;
  target: ReturnType<typeof targetForTrack>;
  targetKey: string;
  track: TrackFile;
};
type OrganizeMoveResult = Omit<OrganizeApplyResult, "plan">;

export function targetForTrack(track: TrackFile, settings: PrivateSettings) {
  return targetForRelativePath(track, settings, templateRelativePath(track, settings, track.extension.startsWith(".") ? track.extension : `.${track.extension}`));
}

function targetForRelativePath(track: TrackFile, settings: PrivateSettings, targetRelativePath: string) {
  const root = path.resolve(settings.naming.libraryPath);
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
  const plannedItems: PlannedOrganizeItem[] = tracks.map((track) => {
    const target = targetForTrack(track, settings);
    const item: OrganizePlanItem = {
      id: track.id,
      sourcePath: track.absolutePath,
      targetPath: target.targetPath,
      sourceRelativePath: track.relativePath,
      targetRelativePath: target.targetRelativePath,
      targetSource: track.targetSource ?? "naviclean",
      managedBy: track.managedBy,
      status: "ready",
      message: "Ready"
    };

    return {
      item,
      target,
      targetKey: path.resolve(target.targetPath),
      track
    };
  });
  const tracksBySourcePath = new Map(tracks.map((track) => [path.resolve(track.absolutePath), track]));
  const plannedItemsByTargetPath = new Map<string, PlannedOrganizeItem[]>();

  for (const planned of plannedItems) {
    const targetGroup = plannedItemsByTargetPath.get(planned.targetKey) || [];
    targetGroup.push(planned);
    plannedItemsByTargetPath.set(planned.targetKey, targetGroup);
  }

  for (const planned of plannedItems) {
    const { item, target, targetKey, track } = planned;
    const targetGroup = plannedItemsByTargetPath.get(targetKey) || [];
    const targetStat = target.outsideLibrary ? null : await statIfExists(target.targetPath);
    const collision = buildCollision(
      track,
      target,
      targetGroup,
      tracksBySourcePath.get(targetKey),
      targetStat
    );

    if (collision) {
      item.collision = collision;
    }

    if (target.outsideLibrary) {
      item.status = "outside-library";
      item.message = "Target leaves library root";
    } else if (!(await pathExists(track.absolutePath))) {
      item.status = "missing-source";
      item.message = "Source file is missing";
    } else if (path.resolve(track.absolutePath) === path.resolve(target.targetPath)) {
      item.status = "same";
      item.message = "Already organized";
    } else if (collision?.duplicateKeyMatches) {
      item.status = "duplicate-target";
      item.message = "Target is shared by duplicate candidates";
    } else if (targetStat && path.resolve(track.absolutePath) !== path.resolve(target.targetPath)) {
      item.status = "conflict";
      item.message = "Target already exists";
    } else if (targetGroup.length > 1) {
      item.status = "conflict";
      item.message = "Multiple tracks resolve to this target";
    } else if (track.managedBy === "spotifybu") {
      item.status = "same";
      item.message = "Managed by SpotifyBU";
    }

    items.push(item);
  }

  return {
    items,
    warnings: [],
    summary: {
      ready: items.filter((item) => item.status === "ready").length,
      same: items.filter((item) => item.status === "same").length,
      duplicateTargets: items.filter((item) => item.status === "duplicate-target").length,
      conflicts: items.filter((item) => item.status === "conflict" || item.status === "outside-library").length,
      missing: items.filter((item) => item.status === "missing-source").length
    }
  };
}

function buildCollision(
  track: TrackFile,
  target: ReturnType<typeof targetForTrack>,
  targetGroup: PlannedOrganizeItem[],
  existingTargetTrack: TrackFile | undefined,
  targetStat: Stats | null
): OrganizeCollision | undefined {
  const hasTargetCollision = Boolean(targetStat) && path.resolve(track.absolutePath) !== path.resolve(target.targetPath);
  const hasPlannedCollision = targetGroup.length > 1;

  if (!hasTargetCollision && !hasPlannedCollision) {
    return undefined;
  }

  const candidates = new Map<string, OrganizeCollisionCandidate>();

  for (const planned of targetGroup) {
    const role = planned.track.id === track.id ? "source" : "same-target";
    candidates.set(trackIdentity(planned.track), trackToCollisionCandidate(planned.track, role));
  }

  if (existingTargetTrack) {
    candidates.set(trackIdentity(existingTargetTrack), trackToCollisionCandidate(existingTargetTrack, "existing-target"));
  } else if (targetStat && target.targetRelativePath) {
    const fileCandidate = fileToCollisionCandidate(target, targetStat);
    candidates.set(fileCandidate.id, fileCandidate);
  }

  if (candidates.size < 2) {
    return undefined;
  }

  const candidateList = Array.from(candidates.values());
  const duplicateKeys = new Set(candidateList.map((candidate) => candidate.duplicateKey).filter(Boolean));
  const duplicateKeyMatches =
    duplicateKeys.size === 1 &&
    candidateList.every((candidate) => Boolean(candidate.trackId) && candidate.duplicateKey === duplicateKeyForTrack(track));

  return {
    duplicateKeyMatches,
    candidates: candidateList.sort(compareCollisionCandidates)
  };
}

function trackIdentity(track: TrackFile) {
  return `${track.id}:${path.resolve(track.absolutePath)}`;
}

function trackToCollisionCandidate(track: TrackFile, role: OrganizeCollisionCandidate["role"]): OrganizeCollisionCandidate {
  return {
    id: `track:${track.id}`,
    trackId: track.id,
    role,
    absolutePath: track.absolutePath,
    relativePath: track.relativePath,
    targetRelativePath: track.targetRelativePath,
    artist: track.artist,
    albumArtist: track.albumArtist,
    album: track.album,
    albumType: track.albumType,
    title: track.title,
    extension: track.extension,
    size: track.size,
    duration: track.duration,
    bitrate: track.bitrate,
    sampleRate: track.sampleRate,
    bitsPerSample: track.bitsPerSample,
    codec: track.codec,
    container: track.container,
    lossless: track.lossless,
    qualityScore: track.qualityScore,
    duplicateKey: duplicateKeyForTrack(track)
  };
}

function fileToCollisionCandidate(target: ReturnType<typeof targetForTrack>, stat: Stats): OrganizeCollisionCandidate {
  const parsed = path.parse(target.targetPath);

  return {
    id: `file:${target.targetRelativePath}`,
    trackId: null,
    role: "existing-target",
    absolutePath: target.targetPath,
    relativePath: target.targetRelativePath,
    targetRelativePath: target.targetRelativePath,
    artist: "",
    albumArtist: "",
    album: "",
    albumType: "",
    title: parsed.name,
    extension: parsed.ext,
    size: stat.size,
    duration: null,
    bitrate: null,
    sampleRate: null,
    bitsPerSample: null,
    codec: null,
    container: null,
    lossless: false,
    qualityScore: null,
    duplicateKey: ""
  };
}

function compareCollisionCandidates(left: OrganizeCollisionCandidate, right: OrganizeCollisionCandidate) {
  const roleOrder: Record<OrganizeCollisionCandidate["role"], number> = {
    source: 0,
    "existing-target": 1,
    "same-target": 2
  };
  const roleDifference = roleOrder[left.role] - roleOrder[right.role];

  if (roleDifference !== 0) {
    return roleDifference;
  }

  if ((right.qualityScore ?? -1) !== (left.qualityScore ?? -1)) {
    return (right.qualityScore ?? -1) - (left.qualityScore ?? -1);
  }

  return (right.size ?? 0) - (left.size ?? 0);
}

export async function applyOrganizePlan(plan: OrganizePlan): Promise<OrganizeMoveResult> {
  const result: OrganizeMoveResult = {
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

export async function trashOrganizeCandidate(
  settings: PrivateSettings,
  tracks: TrackFile[],
  itemId: string,
  candidateId: string
): Promise<OrganizeTrashResult & { tracks: TrackFile[] }> {
  return trashOrganizeCandidates(settings, tracks, [{ itemId, candidateId }]);
}

export async function trashOrganizeCandidates(
  settings: PrivateSettings,
  tracks: TrackFile[],
  selections: OrganizeTrashSelection[]
): Promise<OrganizeTrashResult & { tracks: TrackFile[] }> {
  if (selections.length === 0) {
    throw new Error("At least one organize blocker selection is required.");
  }

  const plan = await buildOrganizePlan(tracks, settings);
  const selectedCandidates = new Map<string, OrganizeCollisionCandidate>();

  for (const selection of selections) {
    const item = plan.items.find((candidateItem) => candidateItem.id === selection.itemId);
    const candidate = item?.collision?.candidates.find(
      (collisionCandidate) => collisionCandidate.id === selection.candidateId
    );

    if (!item || !candidate) {
      throw new Error("One or more organize blockers are no longer valid. Refresh the preview and try again.");
    }

    selectedCandidates.set(path.resolve(candidate.absolutePath), candidate);
  }

  const libraryRoot = path.resolve(settings.naming.libraryPath);
  const trashRoot = path.resolve(settings.naming.recycleBinPath);
  const nowFolder = new Date().toISOString().replace(/[:.]/g, "-");
  const removedTrackIds = new Set<string>();
  const removedPaths = new Set<string>();
  const errors: string[] = [];
  let trashed = 0;

  for (const candidate of selectedCandidates.values()) {
    const sourcePath = path.resolve(candidate.absolutePath);

    if (!isInsidePath(libraryRoot, sourcePath)) {
      errors.push(`${candidate.relativePath}: only files inside the configured library can be recycled from organize`);
      continue;
    }

    if (!(await pathExists(sourcePath))) {
      errors.push(`${candidate.relativePath}: already missing. Scan or refresh before continuing`);
      continue;
    }

    try {
      const trashPath = path.join(trashRoot, nowFolder, candidate.relativePath);
      await fs.mkdir(path.dirname(trashPath), { recursive: true });
      await moveFile(sourcePath, trashPath);
      trashed += 1;
      removedPaths.add(sourcePath);

      if (candidate.trackId) {
        removedTrackIds.add(candidate.trackId);
      }
    } catch (error) {
      errors.push(`${candidate.relativePath}: ${(error as Error).message}`);
    }
  }

  const nextTracks = tracks.filter((track) => {
    if (removedTrackIds.has(track.id)) {
      return false;
    }

    if (removedPaths.has(path.resolve(track.absolutePath))) {
      removedTrackIds.add(track.id);
      return false;
    }

    return true;
  });

  return {
    trashed,
    removedTrackIds: Array.from(removedTrackIds),
    errors,
    tracks: nextTracks,
    plan: await buildOrganizePlan(nextTracks, settings)
  };
}

export function trackNeedsMove(track: TrackFile) {
  return track.managedBy !== "spotifybu" && path.resolve(track.absolutePath) !== path.resolve(track.targetPath);
}

function templateRelativePath(track: TrackFile, settings: PrivateSettings, extension: string) {
  const tokens = toTemplateTokens(track);
  const naming = { ...settings.naming, ...standardNamingFormatDefaults };
  const renderedArtist = renderTemplate(standardNamingFormatDefaults.artistFolderFormat, tokens);
  const renderedTrack = renderTemplate(selectTrackFormat(track), tokens);
  const segments = [
    ...pathSegmentsFromTemplate(renderedArtist, naming),
    ...pathSegmentsFromTemplate(renderedTrack, naming)
  ];
  const filename = segments.pop() || "Unknown Track";
  return path.posix.join(...segments, `${filename}${extension}`);
}

function selectTrackFormat(track: TrackFile) {
  const isMultiDisc = typeof track.discNumber === "number" && track.discNumber > 1;

  if (isMultiDisc) {
    return standardNamingFormatDefaults.multiDiscTrackFormat;
  }

  return standardNamingFormatDefaults.standardTrackFormat;
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
    "albumtype": albumTypeToken(track),
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
  segment = replaceTemplateColon(segment, naming);

  for (let index = 0; index < unsafePathCharacters.length; index += 1) {
    segment = segment.replaceAll(
      unsafePathCharacters[index],
      naming.replaceIllegalCharacters ? pathReplacementCharacters[index] : ""
    );
  }

  segment = segment.replace(controlCharacters, "").replace(/\s+/g, " ").replace(/\.+$/g, "").trim();
  segment = cleanupRenderedTemplateSegment(segment);

  if (!segment || segment === "." || segment === "..") {
    return "";
  }

  if (reservedWindowsNames.test(segment)) {
    segment = `_${segment}`;
  }

  return segment.slice(0, 180).trim();
}

function replaceTemplateColon(value: string, naming: PrivateSettings["naming"]) {
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

function albumTypeToken(track: TrackFile) {
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

  return albumType ? titleCaseAlbumType(albumType) : "";
}

function titleCaseAlbumType(value: string) {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function releaseYear(track: TrackFile) {
  return track.year ? String(track.year) : unknownReleaseYear;
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function statIfExists(filePath: string) {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
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
