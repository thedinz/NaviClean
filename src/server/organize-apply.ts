import fs from "node:fs/promises";
import type { OrganizeApplyStatus, OrganizePlan, TrackFile } from "../shared/types.js";
import { saveCatalog } from "./catalog.js";
import { startOrganizeRun } from "./organize-journal.js";
import { invalidateOrganizeEvaluationCache } from "./organize-service.js";
import { applyOrganizePlan } from "./organizer.js";
import { moveTrackDecisions } from "./track-decisions.js";

const applyStatus: OrganizeApplyStatus = {
  running: false,
  label: null,
  startedAt: null,
  finishedAt: null,
  total: 0,
  processed: 0,
  moved: 0,
  errors: [],
  runId: null,
  error: null
};

export function getOrganizeApplyStatus(): OrganizeApplyStatus {
  return applyStatus;
}

export function isOrganizeApplyRunning() {
  return applyStatus.running;
}

/**
 * Moves and retags the reviewed plan items, then records their new paths in the decisions and
 * the catalog. The status is marked running before the first await, so a caller can reply with
 * it right away and let a large apply finish without holding the HTTP request open.
 * The caller must hold the library lock until the returned promise settles; it never rejects.
 */
export function runOrganizeApply(plan: OrganizePlan, tracks: TrackFile[], label: string): Promise<void> {
  Object.assign(applyStatus, {
    running: true,
    label,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: plan.items.length,
    processed: 0,
    moved: 0,
    errors: [],
    runId: null,
    error: null
  } satisfies OrganizeApplyStatus);

  return applyAndRecord(plan, tracks, label)
    .catch((error: Error) => {
      applyStatus.error = error.message;
    })
    .finally(() => {
      applyStatus.running = false;
      applyStatus.finishedAt = new Date().toISOString();
    });
}

async function applyAndRecord(plan: OrganizePlan, tracks: TrackFile[], label: string) {
  const run = startOrganizeRun(label);
  const result = await applyOrganizePlan(plan, tracks, run.record, (processed) => {
    applyStatus.processed = processed;
  }).finally(() => {
    applyStatus.runId = run.close();
  });
  applyStatus.moved = result.moved;
  applyStatus.errors = result.errors;

  if (result.moved === 0) {
    return;
  }

  // Canonical retagging rewrites files before they move, so record their new size and mtime;
  // decisions and the catalog would otherwise describe the pre-retag file.
  const moved = await Promise.all(
    result.items
      .filter((item) => item.applied)
      .map(async (item) => ({ item, stat: await fs.stat(item.targetPath) }))
  );
  await moveTrackDecisions(
    moved.map(({ item, stat }) => ({ sourcePath: item.sourcePath, targetPath: item.targetPath, size: stat.size }))
  );
  const movedById = new Map(moved.map((entry) => [entry.item.id, entry]));
  await saveCatalog(
    tracks.map((track) => {
      const entry = movedById.get(track.id);
      return entry
        ? {
            ...track,
            absolutePath: entry.item.targetPath,
            relativePath: entry.item.targetRelativePath,
            targetPath: entry.item.targetPath,
            targetRelativePath: entry.item.targetRelativePath,
            size: entry.stat.size,
            mtimeMs: entry.stat.mtimeMs
          }
        : track;
    })
  );
  invalidateOrganizeEvaluationCache();
}
