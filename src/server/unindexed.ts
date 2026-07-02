import path from "node:path";
import type { TrackFile, UnindexedFilesView, UnindexedTrashResult } from "../shared/types.js";
import { trashLibraryTracks } from "./library.js";
import type { PrivateSettings } from "./settings.js";

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
