import type { QuarantineEntry } from "../../shared/types.js";
import { execute, queryAll } from "../db.js";

/**
 * Sources that failed verification for a track. The scorer drops them from every later
 * search for the same track, so a known-bad upload is never picked twice.
 */
export function quarantineCandidate(candidateId: string, trackKey: string, reason: string, detail: string) {
  execute(
    "INSERT OR REPLACE INTO quarantine (candidate_id, track_key, reason, detail, created_at) VALUES (?, ?, ?, ?, ?)",
    candidateId,
    trackKey,
    reason,
    detail,
    new Date().toISOString()
  );
}

export function quarantinedCandidateIds(trackKey: string) {
  return new Set(
    queryAll<{ candidate_id: string }>("SELECT candidate_id FROM quarantine WHERE track_key = ?", trackKey).map(
      (row) => row.candidate_id
    )
  );
}

export function listQuarantine(limit = 500): QuarantineEntry[] {
  return queryAll<{ candidate_id: string; track_key: string; reason: string; detail: string; created_at: string }>(
    "SELECT candidate_id, track_key, reason, detail, created_at FROM quarantine ORDER BY created_at DESC LIMIT ?",
    limit
  ).map((row) => ({
    candidateId: row.candidate_id,
    trackKey: row.track_key,
    reason: row.reason,
    detail: row.detail,
    createdAt: row.created_at
  }));
}

export function releaseQuarantine(candidateId?: string, trackKey?: string) {
  if (candidateId && trackKey) {
    execute("DELETE FROM quarantine WHERE candidate_id = ? AND track_key = ?", candidateId, trackKey);
  } else {
    execute("DELETE FROM quarantine");
  }
}
