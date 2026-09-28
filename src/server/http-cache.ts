import { execute, parseJson, queryOne } from "./db.js";

/** Returns a cached upstream response, or null when it is missing or expired. */
export function httpCacheGet<T>(key: string): T | null {
  const row = queryOne<{ data: string; expires_at: number }>(
    "SELECT data, expires_at FROM http_cache WHERE key = ?",
    key
  );
  if (!row || row.expires_at < Date.now()) {
    return null;
  }
  return parseJson<T>(row.data);
}

export function httpCacheSet(key: string, value: unknown, ttlMs: number) {
  const now = Date.now();
  execute(
    "INSERT OR REPLACE INTO http_cache (key, data, fetched_at, expires_at) VALUES (?, ?, ?, ?)",
    key,
    JSON.stringify(value),
    now,
    now + ttlMs
  );
}

export function pruneHttpCache() {
  execute("DELETE FROM http_cache WHERE expires_at < ?", Date.now());
}
