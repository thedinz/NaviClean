import path from "node:path";
import type { TrackFile } from "../shared/types.js";
import { targetForTrack } from "./organizer.js";
import type { PrivateSettings } from "./settings.js";

export function trustPathMetadataForFolder(
  settings: PrivateSettings,
  tracks: TrackFile[],
  localTrackId: string
) {
  const selected = tracks.find((track) => track.id === localTrackId);

  if (!selected) {
    throw new Error("The local track is no longer in the current scan. Refresh the organize preview and try again.");
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
      track.metadataConfidence !== "path-suggestion" ||
      !track.metadataSuggestion?.artist ||
      !track.metadataSuggestion.album
    ) {
      return track;
    }

    const partialTrack = {
      ...track,
      metadataConfidence: "trusted-path" as const,
      issues: track.issues.filter((issue) => issue !== "Path-derived artist or album requires metadata review")
    };
    const target = targetForTrack(partialTrack, settings);
    updatedTrackIds.push(track.id);
    return {
      ...partialTrack,
      targetPath: target.targetPath,
      targetRelativePath: target.targetRelativePath
    };
  });

  return {
    tracks: nextTracks,
    trustedTracks: updatedTrackIds.length,
    updatedTrackIds
  };
}
