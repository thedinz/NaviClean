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
import { fetchNavidromeLibraryTracks, searchNavidromeLibraryTrackCandidates, type NavidromeLibraryTrack } from "./navidrome.js";
import {
  buildNavidromeMatchIndex,
  durationBucket,
  filenameSizeKey,
  findIndexedNavidromeMatch,
  indexedNavidromeLookup,
  navidromeCandidateMatchMethod,
  navidromeCandidateMatchMethods,
  navidromeMatchLabel,
  navidromeMetadataKeysMatch,
  navidromePathKey,
  navidromeRelativePathKey,
  type NavidromeMatchIndex,
  type NavidromeTrackMatch
} from "./navidrome-matching.js";
import type { PrivateSettings } from "./settings.js";
import { normalizeForMatch } from "./utils.js";

const unindexedDiagnosticCodes = new Set(["no-api-match", "possible-stale-scan"]);
/** Candidate score added for each relaxed match tier (the exact path and key tiers are scored from the checks). */
const relaxedTierScores: Partial<Record<NavidromeMetadataMatchMethod, number>> = {
  "metadata-size-relaxed-duration": 85,
  "edition-metadata-size": 75,
  "metadata-size-title-suffix": 82,
  "edition-title-suffix-metadata-size": 83,
  "metadata-size-track-agnostic": 84,
  "metadata-size-artist-agnostic": 86
};

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
  const preliminaryCandidates = result.tracks.map((candidate) => compareNavidromeCandidate(track, candidate));
  const scanMatchContext = preliminaryCandidates.some((candidate) => candidate.acceptedBy)
    ? await fullScanMatchContext(settings, track)
    : null;
  const candidates = result.tracks.map((candidate) => compareNavidromeCandidate(track, candidate, scanMatchContext));
  const acceptedCount = candidates.filter((candidate) => candidate.acceptedBy).length;

  return {
    query: result.query,
    track,
    candidates: candidates.sort(compareCandidateMatches),
    message: acceptedCount
      ? `${acceptedCount.toLocaleString()} Navidrome ${acceptedCount === 1 ? "candidate would" : "candidates would"} match after a NaviClean scan refreshes the catalog.`
      : candidates.length
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

type FullScanMatchContext = {
  error: string | null;
  index: NavidromeMatchIndex | null;
  match: NavidromeTrackMatch | null;
};

async function fullScanMatchContext(settings: PrivateSettings, track: TrackFile): Promise<FullScanMatchContext> {
  try {
    const navidromeTracks = await fetchNavidromeLibraryTracks(settings);
    const index = buildNavidromeMatchIndex(navidromeTracks);

    return {
      error: null,
      index,
      match: findIndexedNavidromeMatch(index, track)
    };
  } catch (error) {
    return {
      error: (error as Error).message,
      index: null,
      match: null
    };
  }
}

function compareNavidromeCandidate(
  track: TrackFile,
  candidate: NavidromeLibraryTrack,
  scanMatchContext?: FullScanMatchContext | null
): UnindexedNavidromeCandidate {
  const checks = {
    absolutePath: pathComparison(track.absolutePath, candidate.sourceAbsolutePath, navidromePathKey),
    relativePath: pathComparison(track.relativePath, candidate.sourceRelativePath, navidromeRelativePathKey),
    filenameSize: filenameSizeComparison(track, candidate),
    metadataKey: navidromeMetadataKeysMatch(track, candidate) ? "match" as const : "different" as const
  };
  const individualAcceptedBy = navidromeCandidateMatchMethod(track, candidate);
  const acceptedBy =
    scanMatchContext && scanMatchContext.match?.track.id === candidate.id
      ? scanMatchContext.match.method
      : scanMatchContext
      ? null
      : individualAcceptedBy;
  const rejectedReasons = acceptedBy
    ? [`This candidate would now match by ${navidromeMatchLabel(acceptedBy)}. Run a NaviClean scan to refresh this page.`]
    : individualAcceptedBy && scanMatchContext
    ? fullScanRejectionReasons(track, candidate, individualAcceptedBy, scanMatchContext)
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

function fullScanRejectionReasons(
  track: TrackFile,
  candidate: NavidromeLibraryTrack,
  method: NavidromeMetadataMatchMethod,
  context: FullScanMatchContext
) {
  if (context.error) {
    return [
      `This candidate matches by ${navidromeMatchLabel(method)} in Navidrome search, but NaviClean could not verify the full scan catalog: ${context.error}.`
    ];
  }

  if (context.match) {
    return [
      `This candidate matches by ${navidromeMatchLabel(method)} in Navidrome search, but a full NaviClean scan would choose another Navidrome record first by ${navidromeMatchLabel(context.match.method)}.`
    ];
  }

  const lookup = context.index ? indexedNavidromeLookup(context.index, track, method) : undefined;

  if (lookup === null) {
    return [
      `This candidate matches by ${navidromeMatchLabel(method)} in Navidrome search, but the full Navidrome catalog has multiple records with that same match key. NaviClean leaves it unmatched instead of guessing.`
    ];
  }

  if (!lookup) {
    return [
      `This candidate matches by ${navidromeMatchLabel(method)} in Navidrome search, but the full Navidrome album catalog used by scans does not expose the same match key. NaviClean cannot use it during a scan.`
    ];
  }

  if (lookup.id !== candidate.id) {
    return [
      `This candidate matches by ${navidromeMatchLabel(method)} in Navidrome search, but the full Navidrome catalog maps that key to a different record. NaviClean leaves this search candidate unmatched.`
    ];
  }

  return [
    `This candidate matches by ${navidromeMatchLabel(method)} in Navidrome search, but NaviClean did not accept it during the full scan catalog check.`
  ];
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
  for (const method of navidromeCandidateMatchMethods(track, candidate)) {
    score += relaxedTierScores[method] ?? 0;
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

function normalizeMetadataText(value: string) {
  return normalizeForMatch(value, { removeBracketedText: false });
}

function formatBytes(value: number) {
  if (!Number.isFinite(value)) {
    return "unknown size";
  }

  return `${value.toLocaleString()} bytes`;
}
