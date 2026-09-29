import type { TrackFile } from "../shared/types.js";
import { duplicateKeyForTrack } from "./matching.js";
import { targetForTrack } from "./organizer.js";
import type { PrivateSettings } from "./settings.js";

/** Issue recorded by the scanner while a track's artist/album only comes from its path. */
export const pathReviewIssue = "Path-derived artist or album requires metadata review";

/**
 * Applies an identity change to a track: the patched fields, then everything derived from them.
 *
 * Every place that decides what a track *is* (scanning, fingerprint identification, a Spotify
 * match, trusting a folder) goes through here, so the duplicate key, the target path and the
 * review issue can never be left describing the previous identity.
 */
export function withIdentity(track: TrackFile, settings: PrivateSettings, patch: Partial<TrackFile> = {}): TrackFile {
  const next: TrackFile = { ...track, ...patch };

  if (next.metadataConfidence !== "path-suggestion" && next.issues.includes(pathReviewIssue)) {
    next.issues = next.issues.filter((issue) => issue !== pathReviewIssue);
  }

  const target = targetForTrack(next, settings);
  return {
    ...next,
    duplicateKey: duplicateKeyForTrack(next),
    targetPath: target.targetPath,
    targetRelativePath: target.targetRelativePath
  };
}
