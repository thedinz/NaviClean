import type { TrackIdentificationStatus } from "./types.js";

/** Identity states that never need review: TrackKeep tags, user decisions, and existing MusicBrainz tags. */
export function isConfirmedIdentityStatus(status: TrackIdentificationStatus | undefined) {
  return status === "trackkeep-confirmed" || status === "user-confirmed" || status === "musicbrainz-tagged";
}
