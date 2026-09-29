import { isConfirmedIdentityStatus } from "../shared/identity.js";
import type { TrackFile } from "../shared/types.js";
import type { PrivateSettings } from "./settings.js";
import { isTrackKeepManaged } from "./trackkeep.js";

/**
 * Whether a track's identity still needs the user's confirmation before NaviClean may move or
 * retag it. The organizer and the scan summary both use this one rule.
 */
export function identificationNeedsReview(track: TrackFile, settings: PrivateSettings) {
  const status = track.identification?.status;

  if (!status || isTrackKeepManaged(track.managedBy) || isConfirmedIdentityStatus(status)) {
    return false;
  }

  if (status === "fingerprint-and-release-confirmed") {
    return settings.identification.requireReviewBeforeFileChanges;
  }

  return true;
}
