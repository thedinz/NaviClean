import type { OrganizePlan, TrackFile, WorkflowState } from "../shared/types.js";
import type { Catalog } from "./catalog.js";
import { attachCrossChecks } from "./organize-crosscheck.js";
import { buildOrganizePlan } from "./organizer.js";
import type { PrivateSettings } from "./settings.js";

export type OrganizeEvaluation = {
  key: string;
  plan: OrganizePlan;
  tracks: TrackFile[];
  workflow: WorkflowState;
};

const workflowWarnings = [
  "Duplicate cleanup is intentionally conservative and only unlocks after organization is complete.",
  "Different albums, compilations, live versions, acoustic versions, and best-of releases should remain separate."
];

let cachedEvaluation: OrganizeEvaluation | null = null;
let cacheToken = 0;

/** Returns the cached plan when the catalog and relevant settings are unchanged. */
export async function getOrganizeEvaluation(catalog: Catalog, settings: PrivateSettings): Promise<OrganizeEvaluation> {
  if (cachedEvaluation?.key === evaluationKey(catalog, settings)) {
    return cachedEvaluation;
  }

  return rebuildOrganizeEvaluation(catalog, settings);
}

/** Re-plans against the disk and caches the result unless the cache was invalidated meanwhile. */
export async function rebuildOrganizeEvaluation(catalog: Catalog, settings: PrivateSettings): Promise<OrganizeEvaluation> {
  const token = cacheToken;
  const plan = attachCrossChecks(await buildOrganizePlan(catalog.tracks, settings), catalog.tracks);
  const evaluation: OrganizeEvaluation = {
    key: evaluationKey(catalog, settings),
    plan,
    tracks: catalog.tracks,
    workflow: workflowStateFromPlan(catalog.updatedAt, catalog.tracks.length, plan)
  };

  if (token === cacheToken) {
    cachedEvaluation = evaluation;
  }

  return evaluation;
}

export function invalidateOrganizeEvaluationCache() {
  cachedEvaluation = null;
  cacheToken += 1;
}

export async function buildWorkflowState(catalog: Catalog, settings: PrivateSettings) {
  return (await getOrganizeEvaluation(catalog, settings)).workflow;
}

export function workflowStateDuringScan(lastScanFinishedAt: string | null): WorkflowState {
  return {
    stage: "scan",
    duplicateScanReady: false,
    scanned: Boolean(lastScanFinishedAt),
    pendingMoves: 0,
    organizationConflicts: 0,
    metadataReview: 0,
    missingFiles: 0,
    message: "Stage 1: scan is running. Organization and duplicate cleanup unlock after the scan finishes.",
    warnings: workflowWarnings
  };
}

function evaluationKey(catalog: Catalog, settings: PrivateSettings) {
  return JSON.stringify({
    catalogUpdatedAt: catalog.updatedAt,
    trackCount: catalog.tracks.length,
    naming: settings.naming,
    identification: settings.identification
  });
}

function workflowStateFromPlan(lastScanFinishedAt: string | null, totalTracks: number, plan: OrganizePlan): WorkflowState {
  const counts = {
    pendingMoves: plan.summary.ready,
    organizationConflicts: plan.summary.conflicts,
    metadataReview: plan.summary.metadataReview,
    missingFiles: plan.summary.missing
  };
  const scanned = Boolean(lastScanFinishedAt);
  const state = (stage: WorkflowState["stage"], message: string): WorkflowState => ({
    stage,
    duplicateScanReady: stage === "duplicates",
    scanned,
    ...counts,
    message,
    warnings: workflowWarnings
  });

  if (!scanned) {
    return state("scan", "Stage 1: scan the mounted Navidrome library before organizing or finding duplicates.");
  }

  if (totalTracks === 0) {
    return state("scan", "No audio files are in the current catalog. Check the library path and scan again.");
  }

  const blockers = [
    countLabel(counts.pendingMoves, "move"),
    countLabel(counts.organizationConflicts, "conflict"),
    countLabel(counts.metadataReview, "metadata review"),
    countLabel(counts.missingFiles, "missing file")
  ].filter(Boolean);

  if (blockers.length > 0) {
    return state("organize", `Stage 2: review organization (${blockers.join(", ")}).`);
  }

  return state(
    "duplicates",
    "Stage 3: organization is complete. Duplicate cleanup will show same-release matches when any are found."
  );
}

function countLabel(count: number, noun: string) {
  return count > 0 ? `${count} ${noun}${count === 1 ? "" : "s"}` : "";
}
