import type { TrackFile } from "../shared/types.js";

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
