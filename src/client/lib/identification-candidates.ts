import type { TrackFile } from "../../shared/types";

export interface MatchedIdentificationCandidate {
  id: string;
  /** True only when the user picked this release; an automatic match still needs their click. */
  confirmed: boolean;
}

/**
 * The candidate the track's identity currently points at. An automatic fingerprint + release
 * match is returned unconfirmed: with "Require confirmation before file changes" on, the server
 * keeps it in Identity review until the user confirms it, so the page must let them click it.
 */
export function matchedIdentificationCandidate(
  identification: TrackFile["identification"]
): MatchedIdentificationCandidate | null {
  const status = identification?.status;
  if (!identification?.releaseId || (status !== "user-confirmed" && status !== "fingerprint-and-release-confirmed")) {
    return null;
  }

  const sameRelease = (identification.candidates ?? []).filter((candidate) => candidate.releaseId === identification.releaseId);
  const id = (sameRelease.find((candidate) => candidate.recordingId === identification.recordingId) ?? sameRelease[0])?.id;
  return id ? { id, confirmed: status === "user-confirmed" } : null;
}
