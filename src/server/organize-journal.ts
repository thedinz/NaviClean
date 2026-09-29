import fs from "node:fs/promises";
import path from "node:path";
import type { OrganizeRunSummary, TrackFile } from "../shared/types.js";
import { restoreTagSnapshot, type TagSnapshot } from "./canonical-tags.js";
import { execute, parseJson, pathKey, queryAll, queryOne } from "./db.js";
import { moveFileNoOverwrite, pathExists, pruneEmptyDirectories } from "./file-ops.js";
import { withIdentity } from "./identity.js";
import type { OrganizeJournalEntry } from "./organizer.js";
import type { PrivateSettings } from "./settings.js";
import { sha1, toPosixRelative } from "./utils.js";

type RunItemRow = {
  seq: number;
  source_path: string;
  target_path: string;
  applied_size: number;
  tags: string;
};

/**
 * Opens a journal entry for one Apply. Each move is written as soon as it happens, so a crash
 * halfway through a large apply still leaves every completed move undoable.
 */
export function startOrganizeRun(label: string, now = new Date()) {
  const id = sha1(`${now.toISOString()}:${Math.random()}`).slice(0, 16);
  let seq = 0;
  execute("INSERT INTO organize_runs (id, label, created_at) VALUES (?, ?, ?)", id, label, now.toISOString());

  return {
    id,
    record(entry: OrganizeJournalEntry) {
      seq += 1;
      execute(
        "INSERT INTO organize_run_items (run_id, seq, source_path, target_path, applied_size, tags) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        seq,
        path.resolve(entry.sourcePath),
        path.resolve(entry.targetPath),
        entry.appliedSize,
        JSON.stringify(entry.tags)
      );
    },
    /** Drops the run when it moved nothing, so the history only lists runs that can be undone. */
    close() {
      if (seq === 0) {
        execute("DELETE FROM organize_runs WHERE id = ?", id);
      }
      return seq > 0 ? id : null;
    }
  };
}

export function listOrganizeRuns(limit = 20): OrganizeRunSummary[] {
  return queryAll<{ id: string; label: string; created_at: string; undone_at: string | null; moved: number; undoable: number }>(
    `SELECT r.id, r.label, r.created_at, r.undone_at,
            COUNT(i.seq) AS moved,
            COALESCE(SUM(CASE WHEN i.undone_at IS NULL THEN 1 ELSE 0 END), 0) AS undoable
       FROM organize_runs r
       LEFT JOIN organize_run_items i ON i.run_id = r.id
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT ?`,
    limit
  ).map((row) => ({
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    undoneAt: row.undone_at,
    moved: Number(row.moved),
    undoable: Number(row.undoable)
  }));
}

export type OrganizeUndoMove = {
  /** Where the file was after the apply, and where it is again after the undo. */
  fromPath: string;
  toPath: string;
  size: number;
  mtimeMs: number;
};

/**
 * Reverses one run, newest move first: restores the tags the apply replaced, moves the file back to
 * its old path, and removes folders the apply left empty. A file that changed or moved since the
 * apply, or whose old path is taken, is left alone and reported rather than guessed at.
 */
export async function undoOrganizeRun(runId: string, settings: PrivateSettings) {
  const run = queryOne<{ id: string }>("SELECT id FROM organize_runs WHERE id = ?", runId);
  if (!run) {
    throw new Error("That organize run is no longer in the history.");
  }

  const rows = queryAll<RunItemRow>(
    "SELECT seq, source_path, target_path, applied_size, tags FROM organize_run_items WHERE run_id = ? AND undone_at IS NULL ORDER BY seq DESC",
    runId
  );
  const libraryRoot = path.resolve(settings.naming.libraryPath);
  const moves: OrganizeUndoMove[] = [];
  const errors: string[] = [];

  for (const row of rows) {
    const label = toPosixRelative(libraryRoot, row.target_path);
    try {
      const stat = await fs.stat(row.target_path).catch(() => null);
      if (!stat) {
        throw new Error("the file is no longer where the organize run put it");
      }
      if (stat.size !== row.applied_size) {
        throw new Error("the file changed after it was organized, so it was left as it is");
      }
      if (await pathExists(row.source_path)) {
        throw new Error("another file now occupies its original path");
      }

      const tags = parseJson<TagSnapshot>(row.tags);
      if (tags && Object.keys(tags.values).length > 0) {
        await restoreTagSnapshot(row.target_path, tags);
      }
      await fs.mkdir(path.dirname(row.source_path), { recursive: true });
      await moveFileNoOverwrite(row.target_path, row.source_path);
      await pruneEmptyDirectories(libraryRoot, path.dirname(row.target_path)).catch(() => undefined);

      const restored = await fs.stat(row.source_path);
      execute("UPDATE organize_run_items SET undone_at = ? WHERE run_id = ? AND seq = ?", new Date().toISOString(), runId, row.seq);
      moves.push({ fromPath: row.target_path, toPath: row.source_path, size: restored.size, mtimeMs: restored.mtimeMs });
    } catch (error) {
      errors.push(`${label}: ${(error as Error).message}`);
    }
  }

  const remaining = queryOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM organize_run_items WHERE run_id = ? AND undone_at IS NULL",
    runId
  );
  if (Number(remaining?.count ?? 0) === 0) {
    execute("UPDATE organize_runs SET undone_at = ? WHERE id = ?", new Date().toISOString(), runId);
  }

  return { moves, errors };
}

/** Points catalog rows at the paths an undo moved files back to. */
export function tracksAfterUndo(tracks: TrackFile[], moves: OrganizeUndoMove[], settings: PrivateSettings) {
  const libraryRoot = path.resolve(settings.naming.libraryPath);
  const byPath = new Map(moves.map((move) => [pathKey(move.fromPath), move]));
  return tracks.map((track) => {
    const move = byPath.get(pathKey(track.absolutePath));
    // The target is re-derived: it can depend on the current folder name (see namingYear).
    return move
      ? withIdentity(track, settings, {
          absolutePath: move.toPath,
          relativePath: toPosixRelative(libraryRoot, move.toPath),
          size: move.size,
          mtimeMs: move.mtimeMs
        })
      : track;
  });
}
