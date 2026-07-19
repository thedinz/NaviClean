import path from "node:path";
import type { TrackFile } from "../shared/types.js";
import { isTrackKeepManaged } from "./trackkeep.js";

export function setTrackOrganizationSkipped(
  tracks: TrackFile[],
  localTrackId: string,
  skipped: boolean,
  now = new Date()
) {
  const selected = tracks.find((track) => track.id === localTrackId);

  if (!selected) {
    throw new Error("The local track is no longer in the current scan. Refresh the organize preview and try again.");
  }

  if (isTrackKeepManaged(selected.managedBy)) {
    throw new Error("TrackKeep-managed files do not use organizer skip decisions.");
  }

  if (skipped && selected.metadataConfidence !== "path-suggestion") {
    throw new Error("Only tracks with unconfirmed filename or folder metadata can be skipped.");
  }

  if (!skipped && !selected.organizeSkippedAt) {
    throw new Error("This track is not currently skipped.");
  }

  const nextTracks = tracks.map((track) =>
    track.id === localTrackId
      ? { ...track, organizeSkippedAt: skipped ? now.toISOString() : undefined }
      : track
  );

  return {
    tracks: nextTracks,
    skipped,
    updatedTrackIds: [localTrackId]
  };
}

export function preserveOrganizationSkipDecisions(scannedTracks: TrackFile[], previousTracks: TrackFile[]) {
  const skippedByPath = new Map(
    previousTracks
      .filter((track) => typeof track.organizeSkippedAt === "string" && track.organizeSkippedAt)
      .map((track) => [path.resolve(track.absolutePath), track.organizeSkippedAt as string])
  );

  return scannedTracks.map((track) => {
    const organizeSkippedAt = isTrackKeepManaged(track.managedBy)
      ? undefined
      : skippedByPath.get(path.resolve(track.absolutePath));

    return organizeSkippedAt ? { ...track, organizeSkippedAt } : track;
  });
}
