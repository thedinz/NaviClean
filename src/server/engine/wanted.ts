import type { DownloadTrack, WantedItem, WantedStatus } from "../../shared/types.js";
import { execute, parseJson, queryAll, queryOne } from "../db.js";

/**
 * Tracks that could not be acquired yet. A background watcher re-searches them on a
 * growing interval; a verified match downloads and imports without prompting.
 */

const hour = 1000 * 60 * 60;
// 1 h, 6 h, 1 day, 3 days, then weekly.
const retrySchedule = [hour, 6 * hour, 24 * hour, 72 * hour, 168 * hour];

type WantedRow = {
  id: string;
  status: WantedStatus;
  data: string;
  attempts: number;
  next_attempt_at: number;
  created_at: string;
  updated_at: string;
};

type WantedData = { track: DownloadTrack; reason: string; lastError: string | null };

export function nextRetryDelayMs(attempts: number) {
  return retrySchedule[Math.min(Math.max(attempts - 1, 0), retrySchedule.length - 1)];
}

/** Adds a track to Wanted, or records another failed attempt for it. */
export function recordWanted(track: DownloadTrack, reason: string, error: string | null) {
  const now = new Date();
  const existing = queryOne<WantedRow>("SELECT * FROM wanted WHERE id = ?", track.key);
  const attempts = (existing?.attempts ?? 0) + 1;
  const status: WantedStatus = existing?.status === "paused" ? "paused" : "waiting";
  const data: WantedData = { track, reason, lastError: error };

  execute(
    `INSERT INTO wanted (id, status, data, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data, attempts = excluded.attempts,
       next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at`,
    track.key,
    status,
    JSON.stringify(data),
    attempts,
    now.getTime() + nextRetryDelayMs(attempts),
    existing?.created_at ?? now.toISOString(),
    now.toISOString()
  );
}

/** A track reached the library; it is no longer wanted. */
export function resolveWanted(trackKey: string) {
  execute("DELETE FROM wanted WHERE id = ?", trackKey);
}

export function markWantedSearching(ids: string[]) {
  const now = new Date().toISOString();
  for (const id of ids) {
    execute("UPDATE wanted SET status = 'searching', updated_at = ? WHERE id = ? AND status != 'paused'", now, id);
  }
}

export function dueWanted(limit: number) {
  return queryAll<WantedRow>(
    "SELECT * FROM wanted WHERE status = 'waiting' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
    Date.now(),
    limit
  ).map(toWantedItem).filter((item): item is WantedItem => Boolean(item));
}

export function listWanted(): WantedItem[] {
  return queryAll<WantedRow>("SELECT * FROM wanted ORDER BY status = 'paused', next_attempt_at")
    .map(toWantedItem)
    .filter((item): item is WantedItem => Boolean(item));
}

export function wantedCount() {
  return queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM wanted WHERE status != 'found'")?.count ?? 0;
}

export function setWantedPaused(id: string, paused: boolean) {
  execute(
    "UPDATE wanted SET status = ?, updated_at = ? WHERE id = ?",
    paused ? "paused" : "waiting",
    new Date().toISOString(),
    id
  );
}

/** Makes an item due immediately, so the next watcher pass retries it. */
export function retryWantedNow(id: string) {
  execute(
    "UPDATE wanted SET status = 'waiting', next_attempt_at = ?, updated_at = ? WHERE id = ?",
    Date.now(),
    new Date().toISOString(),
    id
  );
}

export function removeWanted(id: string) {
  execute("DELETE FROM wanted WHERE id = ?", id);
}

/** Searching rows left behind by a restart go back to waiting. */
export function resetInterruptedWanted() {
  execute("UPDATE wanted SET status = 'waiting' WHERE status = 'searching'");
}

function toWantedItem(row: WantedRow): WantedItem | null {
  const data = parseJson<WantedData>(row.data);
  if (!data?.track) {
    return null;
  }
  return {
    id: row.id,
    track: data.track,
    status: row.status,
    attempts: row.attempts,
    reason: data.reason,
    lastError: data.lastError,
    nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
