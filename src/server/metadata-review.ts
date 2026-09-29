import path from "node:path";
import type { TrackFile } from "../shared/types.js";
import { withIdentity } from "./identity.js";
import type { PrivateSettings } from "./settings.js";
import { isTrackKeepManaged } from "./trackkeep.js";

export function trustPathMetadataForFolder(
  settings: PrivateSettings,
  tracks: TrackFile[],
  localTrackId: string
) {
  if (settings.identification && !settings.identification.usePathAsHints) {
    throw new Error("Filename and folder hints are disabled in Settings.");
  }

  const selected = tracks.find((track) => track.id === localTrackId);

  if (!selected) {
    throw new Error("The local track is no longer in the current scan. Refresh the organize preview and try again.");
  }

  if (isTrackKeepManaged(selected.managedBy)) {
    throw new Error("TrackKeep-managed files do not use path metadata trust.");
  }

  if (selected.metadataConfidence !== "path-suggestion") {
    throw new Error("This track does not have unconfirmed path metadata.");
  }

  if (!selected.metadataSuggestion?.artist || !selected.metadataSuggestion.album) {
    throw new Error("This folder does not contain a complete artist and album suggestion. Use Spotify lookup instead.");
  }

  const selectedFolder = path.posix.dirname(selected.relativePath.replace(/\\/g, "/"));
  const updatedTrackIds: string[] = [];
  const nextTracks = tracks.map((track) => {
    const folder = path.posix.dirname(track.relativePath.replace(/\\/g, "/"));
    if (
      folder !== selectedFolder ||
      isTrackKeepManaged(track.managedBy) ||
      track.metadataConfidence !== "path-suggestion" ||
      !track.metadataSuggestion?.artist ||
      !track.metadataSuggestion.album
    ) {
      return track;
    }

    updatedTrackIds.push(track.id);
    return withIdentity(track, settings, {
      organizeSkippedAt: undefined,
      metadataConfidence: "trusted-path",
      // Mark the identity confirmed now; otherwise the organizer keeps the folder in review
      // until the next scan re-derives this status.
      identification: {
        status: "user-confirmed",
        source: "local-path",
        message: "This metadata was explicitly confirmed by the user.",
        fingerprint: track.identification?.fingerprint
      }
    });
  });

  return {
    tracks: nextTracks,
    trustedTracks: updatedTrackIds.length,
    updatedTrackIds
  };
}
