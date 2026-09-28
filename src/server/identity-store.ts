import type { TrackIdentificationCandidate } from "../shared/types.js";
import { getDb, parseJson, pathKey, queryAll, queryOne, transaction } from "./db.js";

export type FingerprintResult = { duration: number; fingerprint: string };

export type StoredIdentity = {
  fingerprint: string;
  source: "trackkeep" | "spotify" | "musicbrainz" | "trusted-path";
  candidate: TrackIdentificationCandidate;
  spotifyTrackId?: string;
  spotifyAlbumId?: string;
  confirmedAt: string;
};

/** Confirmed identities keyed by audio fingerprint, so decisions survive moves and retagging. */
export class IdentityStore {
  private readonly entries = new Map<string, StoredIdentity>();
  private readonly dirty = new Set<string>();

  static load() {
    const store = new IdentityStore();
    for (const row of queryAll<{ fingerprint: string; data: string }>("SELECT fingerprint, data FROM identities")) {
      const entry = parseJson<StoredIdentity>(row.data);
      if (entry?.fingerprint) {
        store.entries.set(row.fingerprint, entry);
      }
    }
    return store;
  }

  get(fingerprint: string) {
    return this.entries.get(fingerprint);
  }

  set(fingerprint: string, entry: StoredIdentity) {
    this.entries.set(fingerprint, entry);
    this.dirty.add(fingerprint);
  }

  flush() {
    if (this.dirty.size === 0) {
      return;
    }

    transaction(() => {
      const upsert = getDb().prepare(
        "INSERT OR REPLACE INTO identities (fingerprint, data, confirmed_at) VALUES (?, ?, ?)"
      );
      for (const fingerprint of this.dirty) {
        const entry = this.entries.get(fingerprint);
        if (entry) {
          upsert.run(fingerprint, JSON.stringify(entry), entry.confirmedAt);
        }
      }
    });
    this.dirty.clear();
  }
}

type FileIdentity = { absolutePath: string; size: number; mtimeMs: number };

/** fpcalc results keyed by path, invalidated whenever the file's size or mtime changes. */
export class FingerprintCache {
  private readonly pending = new Map<string, { file: FileIdentity; result: FingerprintResult }>();

  lookup(file: FileIdentity): FingerprintResult | null {
    const key = pathKey(file.absolutePath);
    const pending = this.pending.get(key);
    if (pending && sameFile(pending.file, file)) {
      return pending.result;
    }

    const row = queryOne<{ size: number; mtime_ms: number; duration: number; fingerprint: string }>(
      "SELECT size, mtime_ms, duration, fingerprint FROM fingerprints WHERE path_key = ?",
      key
    );
    if (!row || row.size !== file.size || row.mtime_ms !== file.mtimeMs) {
      return null;
    }
    return { duration: row.duration, fingerprint: row.fingerprint };
  }

  store(file: FileIdentity, result: FingerprintResult) {
    this.pending.set(pathKey(file.absolutePath), { file, result });
  }

  flush() {
    if (this.pending.size === 0) {
      return;
    }

    transaction(() => {
      const upsert = getDb().prepare(
        "INSERT OR REPLACE INTO fingerprints (path_key, size, mtime_ms, duration, fingerprint, cached_at) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const now = Date.now();
      for (const [key, { file, result }] of this.pending) {
        upsert.run(key, file.size, file.mtimeMs, result.duration, result.fingerprint, now);
      }
    });
    this.pending.clear();
  }
}

function sameFile(left: FileIdentity, right: FileIdentity) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}
