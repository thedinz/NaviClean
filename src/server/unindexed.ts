import path from "node:path";
import type {
  NavidromeMetadataMatchMethod,
  TrackFile,
  UnindexedFilesView,
  UnindexedNavidromeCandidate,
  UnindexedNavidromeComparisonStatus,
  UnindexedNavidromeLookupResult,
  UnindexedTrashResult
} from "../shared/types.js";
import { trashLibraryTracks } from "./library.js";
import { searchNavidromeLibraryTrackCandidates, type NavidromeLibraryTrack } from "./navidrome.js";
import type { PrivateSettings } from "./settings.js";
import { normalizeForMatch } from "./utils.js";

const unindexedDiagnosticCodes = new Set(["no-api-match", "possible-stale-scan"]);

export function listUnindexedFiles(settings: PrivateSettings, tracks: TrackFile[]): UnindexedFilesView {
  const unindexedTracks = tracks.filter(isUnindexedTrack).sort(compareUnindexedTracks);

  return {
    libraryPath: path.resolve(settings.naming.libraryPath),
    total: unindexedTracks.length,
    totalSize: unindexedTracks.reduce((total, track) => total + track.size, 0),
    counts: {
      noApiMatch: unindexedTracks.filter((track) => track.navidromeEnrichment?.code === "no-api-match").length,
      possibleStaleScan: unindexedTracks.filter((track) => track.navidromeEnrichment?.code === "possible-stale-scan").length,
      other: unindexedTracks.filter((track) => !unindexedDiagnosticCodes.has(track.navidromeEnrichment?.code || "")).length
    },
    tracks: unindexedTracks
  };
}

export async function trashUnindexedFiles(
  settings: PrivateSettings,
  tracks: TrackFile[],
  trackIds: string[]
): Promise<UnindexedTrashResult & { tracks: TrackFile[] }> {
  const currentUnindexed = listUnindexedFiles(settings, tracks);
  const currentUnindexedIds = new Set(currentUnindexed.tracks.map((track) => track.id));
  const selectedIds = Array.from(new Set(trackIds.filter(Boolean)));
  const allowedIds = selectedIds.filter((id) => currentUnindexedIds.has(id));
  const errors = selectedIds
    .filter((id) => !currentUnindexedIds.has(id))
    .map((id) => `${id}: file is no longer unindexed in the catalog`);

  if (allowedIds.length === 0) {
    return {
      trashed: 0,
      removedTrackIds: [],
      errors,
      tracks,
      unindexed: currentUnindexed
    };
  }

  const result = await trashLibraryTracks(settings, tracks, allowedIds);
  const nextUnindexed = listUnindexedFiles(settings, result.tracks);

  return {
    trashed: result.trashed,
    removedTrackIds: result.removedTrackIds,
    errors: [...errors, ...result.errors],
    tracks: result.tracks,
    unindexed: nextUnindexed
  };
}

export async function findUnindexedNavidromeMatches(
  settings: PrivateSettings,
  tracks: TrackFile[],
  trackId: string
): Promise<UnindexedNavidromeLookupResult> {
  const track = tracks.find((candidate) => candidate.id === trackId);

  if (!track) {
    throw new Error("Track is no longer in the catalog. Scan or refresh before continuing.");
  }

  if (!isUnindexedTrack(track)) {
    throw new Error("Track is no longer unmatched in the latest NaviClean scan.");
  }

  const result = await searchNavidromeLibraryTrackCandidates(settings, {
    album: track.album,
    albumArtist: track.albumArtist,
    artist: track.artist,
    title: track.title
  });
  const candidates = result.tracks.map((candidate) => compareNavidromeCandidate(track, candidate));

  return {
    query: result.query,
    track,
    candidates: candidates.sort(compareCandidateMatches),
    message: candidates.length
      ? `${candidates.length.toLocaleString()} possible Navidrome ${candidates.length === 1 ? "match" : "matches"} found.`
      : "No Navidrome candidates were found by search."
  };
}

function isUnindexedTrack(track: TrackFile) {
  return track.navidromeEnrichment?.status === "unmatched" && unindexedDiagnosticCodes.has(track.navidromeEnrichment.code);
}

function compareUnindexedTracks(left: TrackFile, right: TrackFile) {
  const reasonDifference = reasonRank(left) - reasonRank(right);

  if (reasonDifference !== 0) {
    return reasonDifference;
  }

  return [
    left.albumArtist.localeCompare(right.albumArtist, undefined, { sensitivity: "base" }),
    left.album.localeCompare(right.album, undefined, { sensitivity: "base" }),
    (left.year ?? 0) - (right.year ?? 0),
    (left.discNumber ?? 1) - (right.discNumber ?? 1),
    (left.trackNumber ?? 0) - (right.trackNumber ?? 0),
    left.title.localeCompare(right.title, undefined, { sensitivity: "base" }),
    left.relativePath.localeCompare(right.relativePath, undefined, { sensitivity: "base" })
  ].find((difference) => difference !== 0) ?? 0;
}

function reasonRank(track: TrackFile) {
  if (track.navidromeEnrichment?.code === "possible-stale-scan") {
    return 0;
  }

  if (track.navidromeEnrichment?.code === "no-api-match") {
    return 1;
  }

  return 2;
}

function compareNavidromeCandidate(track: TrackFile, candidate: NavidromeLibraryTrack): UnindexedNavidromeCandidate {
  const checks = {
    absolutePath: pathComparison(track.absolutePath, candidate.sourceAbsolutePath, pathKey),
    relativePath: pathComparison(track.relativePath, candidate.sourceRelativePath, relativePathKey),
    filenameSize: filenameSizeComparison(track, candidate),
    metadataKey: metadataKeyComparison(track, candidate)
  };
  const acceptedBy = acceptedMatchMethod(track, candidate, checks);
  const rejectedReasons = acceptedBy
    ? [`This candidate would now match by ${matchMethodLabel(acceptedBy)}. Run a NaviClean scan to refresh this page.`]
    : navidromeRejectionReasons(track, candidate, checks);

  return {
    id: candidate.id,
    score: scoreNavidromeCandidate(track, candidate, checks),
    acceptedBy,
    rejectedReasons,
    checks,
    navidrome: {
      path: candidate.sourceRawPath,
      relativePath: candidate.sourceRelativePath,
      pathStatus: candidate.sourcePathStatus,
      artist: candidate.artist,
      albumArtist: candidate.albumArtist,
      album: candidate.album,
      title: candidate.title,
      trackNumber: candidate.trackNumber,
      discNumber: candidate.discNumber,
      year: candidate.year,
      duration: candidate.duration,
      size: candidate.size,
      isrc: candidate.isrc
    }
  };
}

function compareCandidateMatches(left: UnindexedNavidromeCandidate, right: UnindexedNavidromeCandidate) {
  if (Boolean(right.acceptedBy) !== Boolean(left.acceptedBy)) {
    return Number(Boolean(right.acceptedBy)) - Number(Boolean(left.acceptedBy));
  }

  return right.score - left.score || left.navidrome.title.localeCompare(right.navidrome.title);
}

function pathComparison(
  localValue: string | null,
  navidromeValue: string | null,
  normalize: (value: string) => string
): UnindexedNavidromeComparisonStatus {
  if (!localValue || !navidromeValue) {
    return "unavailable";
  }

  return normalize(localValue) === normalize(navidromeValue) ? "match" : "different";
}

function filenameSizeComparison(track: TrackFile, candidate: NavidromeLibraryTrack): UnindexedNavidromeComparisonStatus {
  const localKey = filenameSizeKey(track.relativePath, track.size);
  const navidromeKey = filenameSizeKey(candidate.sourceRelativePath, candidate.size);

  if (!localKey || !navidromeKey) {
    return "unavailable";
  }

  return localKey === navidromeKey ? "match" : "different";
}

function metadataKeyComparison(track: TrackFile, candidate: NavidromeLibraryTrack): UnindexedNavidromeComparisonStatus {
  return trackMetadataKey(track) === navidromeMetadataKey(candidate) ? "match" : "different";
}

function acceptedMatchMethod(
  track: TrackFile,
  candidate: NavidromeLibraryTrack,
  checks: UnindexedNavidromeCandidate["checks"]
): NavidromeMetadataMatchMethod | null {
  if (checks.absolutePath === "match") {
    return "absolute-path";
  }

  if (checks.relativePath === "match") {
    return "relative-path";
  }

  if (checks.filenameSize === "match") {
    return "filename-size";
  }

  if (checks.metadataKey === "match") {
    return "metadata-key";
  }

  if (relaxedDurationKeyForTrack(track) === relaxedDurationKeyForNavidrome(candidate) && durationIsCloseOrMissing(track.duration, candidate.duration)) {
    return "metadata-size-relaxed-duration";
  }

  if (editionMetadataKeyForTrack(track) === editionMetadataKeyForNavidrome(candidate) && durationIsCloseOrMissing(track.duration, candidate.duration)) {
    return "edition-metadata-size";
  }

  return null;
}

function navidromeRejectionReasons(
  track: TrackFile,
  candidate: NavidromeLibraryTrack,
  checks: UnindexedNavidromeCandidate["checks"]
) {
  const reasons: string[] = [];

  if (candidate.sourcePathStatus === "missing") {
    reasons.push("Navidrome did not return a usable path for this candidate.");
  } else if (candidate.sourcePathStatus === "outside-library-root") {
    reasons.push(`Navidrome path is outside NaviClean's configured library root: ${candidate.sourceRawPath || "unknown path"}.`);
  }

  reasons.push(comparisonReason("Absolute path", checks.absolutePath, track.absolutePath, candidate.sourceAbsolutePath));
  reasons.push(comparisonReason("Relative path", checks.relativePath, track.relativePath, candidate.sourceRelativePath));
  reasons.push(
    comparisonReason(
      "Filename+size",
      checks.filenameSize,
      `${path.posix.basename(track.relativePath)} / ${formatBytes(track.size)}`,
      candidate.sourceRelativePath && candidate.size ? `${path.posix.basename(candidate.sourceRelativePath)} / ${formatBytes(candidate.size)}` : null
    )
  );

  if (checks.metadataKey !== "match") {
    reasons.push(`Metadata key differs: ${metadataDifferences(track, candidate).join("; ") || "scanner key values differ"}.`);
  }

  return reasons.filter(Boolean);
}

function comparisonReason(
  label: string,
  status: UnindexedNavidromeComparisonStatus,
  localValue: string | null,
  navidromeValue: string | null
) {
  if (status === "match") {
    return `${label} matches.`;
  }

  if (status === "unavailable") {
    return `${label} could not be compared because Navidrome did not return enough data.`;
  }

  return `${label} differs: local "${localValue || "unknown"}" vs Navidrome "${navidromeValue || "unknown"}".`;
}

function metadataDifferences(track: TrackFile, candidate: NavidromeLibraryTrack) {
  const differences: string[] = [];
  const fields: Array<[string, string | number | null, string | number | null, (value: string) => string]> = [
    ["album artist", track.albumArtist || track.artist, candidate.albumArtist || candidate.artist, normalizeMetadataText],
    ["album", track.album, candidate.album, normalizeMetadataText],
    ["title", track.title, candidate.title, normalizeMetadataText],
    ["disc", track.discNumber ?? 1, candidate.discNumber ?? 1, String],
    ["track", track.trackNumber, candidate.trackNumber, String],
    ["duration bucket", durationBucket(track.duration), durationBucket(candidate.duration), String],
    ["size", track.size, candidate.size, String]
  ];

  for (const [label, localValue, navidromeValue, normalize] of fields) {
    if (normalize(String(localValue ?? "")) !== normalize(String(navidromeValue ?? ""))) {
      differences.push(`${label} local "${localValue ?? ""}" vs Navidrome "${navidromeValue ?? ""}"`);
    }
  }

  return differences;
}

function scoreNavidromeCandidate(
  track: TrackFile,
  candidate: NavidromeLibraryTrack,
  checks: UnindexedNavidromeCandidate["checks"]
) {
  let score = 0;

  if (checks.absolutePath === "match") score += 100;
  if (checks.relativePath === "match") score += 90;
  if (checks.filenameSize === "match") score += 70;
  if (checks.metadataKey === "match") score += 80;
  if (relaxedDurationKeyForTrack(track) === relaxedDurationKeyForNavidrome(candidate) && durationIsCloseOrMissing(track.duration, candidate.duration)) {
    score += 85;
  }
  if (editionMetadataKeyForTrack(track) === editionMetadataKeyForNavidrome(candidate) && durationIsCloseOrMissing(track.duration, candidate.duration)) {
    score += 75;
  }
  if (normalizeMetadataText(track.title) === normalizeMetadataText(candidate.title)) score += 30;
  if (normalizeMetadataText(track.album) === normalizeMetadataText(candidate.album)) score += 20;
  if (normalizeMetadataText(track.albumArtist || track.artist) === normalizeMetadataText(candidate.albumArtist || candidate.artist)) score += 20;
  if (track.trackNumber && track.trackNumber === candidate.trackNumber) score += 10;
  if ((track.discNumber ?? 1) === (candidate.discNumber ?? 1)) score += 5;
  if (track.duration && candidate.duration && Math.abs(track.duration - candidate.duration) <= 2) score += 10;
  if (track.isrc && candidate.isrc && track.isrc === candidate.isrc) score += 40;

  return score;
}

function trackMetadataKey(track: TrackFile) {
  return [
    normalizeMetadataText(track.albumArtist || track.artist),
    normalizeMetadataText(track.album),
    normalizeMetadataText(track.title),
    track.discNumber ?? 1,
    track.trackNumber ?? "",
    durationBucket(track.duration),
    track.size ?? ""
  ].join("|");
}

function navidromeMetadataKey(track: NavidromeLibraryTrack) {
  return [
    normalizeMetadataText(track.albumArtist || track.artist),
    normalizeMetadataText(track.album),
    normalizeMetadataText(track.title),
    track.discNumber ?? 1,
    track.trackNumber ?? "",
    durationBucket(track.duration),
    track.size ?? ""
  ].join("|");
}

function relaxedDurationKeyForTrack(track: TrackFile) {
  return relaxedDurationKey({
    album: track.album,
    albumArtist: track.albumArtist || track.artist,
    discNumber: track.discNumber,
    size: track.size,
    title: track.title,
    trackNumber: track.trackNumber
  });
}

function relaxedDurationKeyForNavidrome(track: NavidromeLibraryTrack) {
  return relaxedDurationKey({
    album: track.album,
    albumArtist: track.albumArtist || track.artist,
    discNumber: track.discNumber,
    size: track.size,
    title: track.title,
    trackNumber: track.trackNumber
  });
}

function editionMetadataKeyForTrack(track: TrackFile) {
  return editionMetadataKey({
    album: track.album,
    albumArtist: track.albumArtist || track.artist,
    discNumber: track.discNumber,
    size: track.size,
    title: track.title,
    trackNumber: track.trackNumber
  });
}

function editionMetadataKeyForNavidrome(track: NavidromeLibraryTrack) {
  return editionMetadataKey({
    album: track.album,
    albumArtist: track.albumArtist || track.artist,
    discNumber: track.discNumber,
    size: track.size,
    title: track.title,
    trackNumber: track.trackNumber
  });
}

function relaxedDurationKey(track: {
  album: string;
  albumArtist: string;
  discNumber: number | null;
  size: number | null;
  title: string;
  trackNumber: number | null;
}) {
  if (!track.albumArtist || !track.album || !track.title || !track.trackNumber || !track.size) {
    return "";
  }

  return [
    normalizeMetadataText(track.albumArtist),
    normalizeMetadataText(track.album),
    normalizeMetadataText(track.title),
    track.discNumber ?? 1,
    track.trackNumber,
    track.size
  ].join("|");
}

function editionMetadataKey(track: {
  album: string;
  albumArtist: string;
  discNumber: number | null;
  size: number | null;
  title: string;
  trackNumber: number | null;
}) {
  if (!track.albumArtist || !track.album || !track.title || !track.trackNumber || !track.size) {
    return "";
  }

  return [
    normalizeMetadataText(track.albumArtist),
    normalizeForMatch(track.album),
    normalizeMetadataText(track.title),
    track.discNumber ?? 1,
    track.trackNumber,
    track.size
  ].join("|");
}

function normalizeMetadataText(value: string) {
  return normalizeForMatch(value, { removeBracketedText: false });
}

function durationIsCloseOrMissing(left: number | null, right: number | null) {
  return !left || !right || Math.abs(left - right) <= 5;
}

function durationBucket(duration: number | null) {
  return duration ? Math.round(duration / 2) * 2 : "";
}

function pathKey(value: string) {
  return path.resolve(value).toLowerCase();
}

function relativePathKey(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

function filenameSizeKey(relativePath: string | null, size: number | null) {
  if (!relativePath || !size) {
    return "";
  }

  return `${path.posix.basename(relativePath.replace(/\\/g, "/")).toLowerCase()}|${size}`;
}

function matchMethodLabel(method: NavidromeMetadataMatchMethod) {
  if (method === "absolute-path") {
    return "absolute path";
  }

  if (method === "relative-path") {
    return "relative path";
  }

  if (method === "filename-size") {
    return "filename+size";
  }

  if (method === "metadata-size-relaxed-duration") {
    return "metadata+size with relaxed duration";
  }

  if (method === "edition-metadata-size") {
    return "edition-compatible metadata+size";
  }

  return "metadata key";
}

function formatBytes(value: number) {
  if (!Number.isFinite(value)) {
    return "unknown size";
  }

  return `${value.toLocaleString()} bytes`;
}
