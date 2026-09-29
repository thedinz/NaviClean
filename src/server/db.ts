import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { getDataDir } from "./settings.js";

type Migration = {
  version: number;
  up: (db: DatabaseSync) => void;
};

let database: DatabaseSync | null = null;
let transactionDepth = 0;

const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE tracks (
          id TEXT PRIMARY KEY,
          path_key TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX tracks_path_key ON tracks(path_key);
        CREATE TABLE metadata_cache (
          path_key TEXT PRIMARY KEY,
          size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          data TEXT NOT NULL,
          cached_at INTEGER NOT NULL
        );
        CREATE TABLE fingerprints (
          path_key TEXT PRIMARY KEY,
          size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          duration INTEGER NOT NULL,
          fingerprint TEXT NOT NULL,
          cached_at INTEGER NOT NULL
        );
        CREATE TABLE identities (
          fingerprint TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          confirmed_at TEXT NOT NULL
        );
        CREATE TABLE http_cache (
          key TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX http_cache_expires ON http_cache(expires_at);
        CREATE TABLE metadata_overrides (
          path_key TEXT PRIMARY KEY,
          data TEXT NOT NULL
        );
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE download_jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX download_jobs_status ON download_jobs(status, created_at);
        CREATE TABLE download_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE quarantine (
          candidate_id TEXT NOT NULL,
          track_key TEXT NOT NULL,
          reason TEXT NOT NULL,
          detail TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (candidate_id, track_key)
        );
        CREATE TABLE wanted (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          data TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX wanted_due ON wanted(status, next_attempt_at);
        CREATE TABLE follows (
          artist_id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_checked_at TEXT
        );
        CREATE TABLE releases (
          id TEXT PRIMARY KEY,
          artist_id TEXT NOT NULL,
          data TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          seen INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'new'
        );
        CREATE INDEX releases_artist ON releases(artist_id);
      `);
    }
  },
  {
    // Organize skips used to live only on catalog rows and were lost whenever a file changed path.
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE organize_skips (
          path_key TEXT PRIMARY KEY,
          absolute_path TEXT NOT NULL,
          skipped_at TEXT NOT NULL
        );
      `);
      const insert = db.prepare("INSERT OR REPLACE INTO organize_skips (path_key, absolute_path, skipped_at) VALUES (?, ?, ?)");
      for (const row of db.prepare("SELECT data FROM tracks").all() as Array<{ data: string }>) {
        const track = parseJson<{ absolutePath?: string; organizeSkippedAt?: string }>(row.data);
        if (track?.absolutePath && typeof track.organizeSkippedAt === "string" && track.organizeSkippedAt) {
          insert.run(pathKey(track.absolutePath), path.resolve(track.absolutePath), track.organizeSkippedAt);
        }
      }
    }
  }
];

export function getDb() {
  if (database) {
    return database;
  }

  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "naviclean.db"));
  db.exec("PRAGMA busy_timeout = 15000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  runMigrations(db);
  database = db;
  importLegacyJsonStores(db, dataDir);
  return db;
}

/** Runs `operation` inside one write transaction; nested calls join the outer transaction. */
export function transaction<T>(operation: () => T): T {
  const db = getDb();

  if (transactionDepth > 0) {
    transactionDepth += 1;
    try {
      return operation();
    } finally {
      transactionDepth -= 1;
    }
  }

  db.exec("BEGIN IMMEDIATE");
  transactionDepth = 1;

  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    transactionDepth = 0;
  }
}

export function queryAll<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function queryOne<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function execute(sql: string, ...params: SQLInputValue[]) {
  return getDb().prepare(sql).run(...params);
}

export function kvGet<T>(key: string): T | null {
  const row = queryOne<{ value: string }>("SELECT value FROM kv WHERE key = ?", key);
  return row ? parseJson<T>(row.value) : null;
}

export function kvSet(key: string, value: unknown) {
  execute(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    JSON.stringify(value)
  );
}

export function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** Case-insensitive, resolved path key shared by every path-indexed table. */
export function pathKey(value: string) {
  return path.resolve(value).toLowerCase();
}

export function closeDbForTests() {
  database?.close();
  database = null;
}

function runMigrations(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((row) => row.version)
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      // Another process may have applied the migration while this one waited for the lock.
      const alreadyApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(migration.version);
      if (!alreadyApplied) {
        migration.up(db);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
          migration.version,
          new Date().toISOString()
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

type LegacyTrack = { id?: string; absolutePath?: string; organizeSkippedAt?: string };

/**
 * Moves the pre-SQLite JSON stores into the database once. The originals are renamed
 * to `*.migrated` so a downgrade can still find them and nothing is silently deleted.
 */
function importLegacyJsonStores(db: DatabaseSync, dataDir: string) {
  const imports: Array<{ file: string; load: (payload: unknown) => void }> = [
    {
      file: "catalog.json",
      load: (payload) => {
        const catalog = payload as { updatedAt?: string | null; tracks?: LegacyTrack[] };
        const insert = db.prepare("INSERT OR REPLACE INTO tracks (id, path_key, data) VALUES (?, ?, ?)");
        const insertSkip = db.prepare(
          "INSERT OR REPLACE INTO organize_skips (path_key, absolute_path, skipped_at) VALUES (?, ?, ?)"
        );
        for (const track of Array.isArray(catalog.tracks) ? catalog.tracks : []) {
          if (track?.id && track.absolutePath) {
            insert.run(track.id, pathKey(track.absolutePath), JSON.stringify(track));
          }
          if (track?.absolutePath && typeof track.organizeSkippedAt === "string" && track.organizeSkippedAt) {
            insertSkip.run(pathKey(track.absolutePath), path.resolve(track.absolutePath), track.organizeSkippedAt);
          }
        }
        db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('catalog.updatedAt', ?)").run(
          JSON.stringify(catalog.updatedAt ?? null)
        );
      }
    },
    {
      file: "track-identities.json",
      load: (payload) => {
        const insert = db.prepare("INSERT OR REPLACE INTO identities (fingerprint, data, confirmed_at) VALUES (?, ?, ?)");
        for (const entry of (payload as { entries?: Array<{ fingerprint?: string; confirmedAt?: string }> }).entries ?? []) {
          if (entry?.fingerprint) {
            insert.run(entry.fingerprint, JSON.stringify(entry), entry.confirmedAt ?? new Date().toISOString());
          }
        }
      }
    },
    {
      file: "fingerprint-cache.json",
      load: (payload) => {
        const insert = db.prepare(
          "INSERT OR REPLACE INTO fingerprints (path_key, size, mtime_ms, duration, fingerprint, cached_at) VALUES (?, ?, ?, ?, ?, ?)"
        );
        type Entry = { absolutePath?: string; size?: number; mtimeMs?: number; duration?: number; fingerprint?: string };
        for (const entry of (payload as { entries?: Entry[] }).entries ?? []) {
          if (entry?.absolutePath && entry.fingerprint) {
            insert.run(
              pathKey(entry.absolutePath),
              Number(entry.size) || 0,
              Number(entry.mtimeMs) || 0,
              Math.round(Number(entry.duration) || 0),
              entry.fingerprint,
              Date.now()
            );
          }
        }
      }
    },
    {
      file: "metadata-overrides.json",
      load: (payload) => {
        const insert = db.prepare("INSERT OR REPLACE INTO metadata_overrides (path_key, data) VALUES (?, ?)");
        for (const entry of (payload as { entries?: Array<{ absolutePath?: string }> }).entries ?? []) {
          if (entry?.absolutePath) {
            insert.run(pathKey(entry.absolutePath), JSON.stringify(entry));
          }
        }
      }
    }
  ];

  for (const { file, load } of imports) {
    const filePath = path.join(dataDir, file);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    try {
      const payload = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      db.exec("BEGIN IMMEDIATE");
      try {
        load(payload);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      fs.renameSync(filePath, `${filePath}.migrated`);
      console.log(`Imported ${file} into the NaviClean database.`);
    } catch (error) {
      console.error(`Could not import ${file}; it was left in place:`, error);
    }
  }
}
