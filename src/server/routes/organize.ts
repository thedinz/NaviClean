import { Router } from "express";
import fs from "node:fs/promises";
import type { OrganizeTrashSelection, TrackFile } from "../../shared/types.js";
import { loadCatalog, saveCatalog, type Catalog } from "../catalog.js";
import { buildDuplicateGroups, resolveDuplicates, resolveSelectedDuplicates } from "../duplicates.js";
import { HttpError, mutation, requireList, requireString, route, stringList } from "../http.js";
import { confirmIdentificationCandidate, rememberConfirmedTrackIdentities } from "../identification.js";
import { trustPathMetadataForFolder } from "../metadata-review.js";
import {
  buildWorkflowState,
  getOrganizeEvaluation,
  invalidateOrganizeEvaluationCache,
  rebuildOrganizeEvaluation
} from "../organize-service.js";
import { setTrackOrganizationSkipped } from "../organize-skip.js";
import { applyOrganizePlan, trashOrganizeCandidates } from "../organizer.js";
import { loadSettings, type PrivateSettings } from "../settings.js";
import { resolveTrackMetadataFromSpotify } from "../spotify-metadata.js";
import { moveTrackDecisions, saveMetadataOverridesForTracks, saveSkipDecision } from "../track-decisions.js";

export const organizeRouter = Router();

organizeRouter.use("/organize", (_req, res, next) => {
  res.set("Cache-Control", "no-store, max-age=0");
  next();
});

organizeRouter.post("/organize/preview", route(async (req, res) => {
  const catalog = await loadCatalog();
  const settings = await loadSettings();
  const quick = req.query.quick === "1" || (req.body as { quick?: boolean } | undefined)?.quick === true;
  const evaluation = quick
    ? await getOrganizeEvaluation(catalog, settings)
    : await rebuildOrganizeEvaluation(catalog, settings);
  res.json(evaluation.plan);
}));

organizeRouter.post("/organize/apply", mutation(async (req, res) => {
  const reviewedFingerprint = String(req.body?.fingerprint || "");
  const catalog = await loadCatalog();
  const settings = await loadSettings();
  // Re-plan against the disk instead of trusting the cache: files may have appeared at targets
  // since the preview, and only the moves the user actually reviewed may be applied.
  const planned = await rebuildOrganizeEvaluation(catalog, settings);
  const plan = planned.plan;

  if (!reviewedFingerprint || plan.fingerprint !== reviewedFingerprint) {
    throw new HttpError(
      409,
      "The organize plan changed since it was reviewed. Nothing was moved; review the refreshed preview and apply again.",
      { plan }
    );
  }

  const result = await applyOrganizePlan(plan, planned.tracks);
  let tracks = planned.tracks;
  let latestCatalog = catalog;

  if (result.moved > 0) {
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
    tracks = planned.tracks.map((track) => {
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
    });
    latestCatalog = await saveCatalog(tracks);
    invalidateOrganizeEvaluationCache();
  }

  const refreshed = await rebuildOrganizeEvaluation({ ...latestCatalog, tracks }, settings);
  res.json({ ...result, plan: refreshed.plan });
}));

organizeRouter.post("/organize/spotify-match", mutation(async (req, res) => {
  const localTrackId = requireString(req.body?.localTrackId, "localTrackId and spotifyTrackId are required");
  const spotifyTrackId = requireString(req.body?.spotifyTrackId, "localTrackId and spotifyTrackId are required");
  const catalog = await loadCatalog();
  const settings = await loadSettings();
  const resolution = await resolveTrackMetadataFromSpotify(settings, catalog.tracks, localTrackId, spotifyTrackId);
  await rememberUserConfirmedTracks(resolution.tracks, resolution.updatedTrackIds, "spotify");
  const plan = await saveAndReplan(resolution.tracks, settings);

  res.json({
    matchedTracks: resolution.matchedTracks,
    updatedTrackIds: resolution.updatedTrackIds,
    selected: resolution.selected,
    plan
  });
}));

organizeRouter.post("/organize/identify-match", mutation(async (req, res) => {
  const localTrackId = requireString(req.body?.localTrackId, "localTrackId is required");
  const candidateId = typeof req.body?.candidateId === "string" ? req.body.candidateId : undefined;
  const catalog = await loadCatalog();
  const settings = await loadSettings();
  const resolution = await confirmIdentificationCandidate(settings, catalog.tracks, localTrackId, candidateId);
  const plan = await saveAndReplan(resolution.tracks, settings);

  res.json({ updatedTrackIds: resolution.updatedTrackIds, plan });
}));

organizeRouter.post("/organize/trust-path", mutation(async (req, res) => {
  const localTrackId = requireString(req.body?.localTrackId, "localTrackId is required");
  const catalog = await loadCatalog();
  const settings = await loadSettings();
  const resolution = trustPathMetadataForFolder(settings, catalog.tracks, localTrackId);
  await rememberUserConfirmedTracks(resolution.tracks, resolution.updatedTrackIds, "trusted-path");
  const plan = await saveAndReplan(resolution.tracks, settings);

  res.json({
    trustedTracks: resolution.trustedTracks,
    updatedTrackIds: resolution.updatedTrackIds,
    plan
  });
}));

organizeRouter.post("/organize/skip", mutation(async (req, res) => {
  const localTrackId = String(req.body?.localTrackId || "");
  const skipped = req.body?.skipped;

  if (!localTrackId || typeof skipped !== "boolean") {
    throw new HttpError(400, "localTrackId and skipped are required");
  }

  const catalog = await loadCatalog();
  const resolution = setTrackOrganizationSkipped(catalog.tracks, localTrackId, skipped);
  const updated = resolution.tracks.find((track) => track.id === localTrackId);
  if (updated) {
    saveSkipDecision(updated);
  }
  const plan = await saveAndReplan(resolution.tracks, await loadSettings());

  res.json({
    skipped: resolution.skipped,
    updatedTrackIds: resolution.updatedTrackIds,
    plan
  });
}));

organizeRouter.post("/organize/trash", mutation(async (req, res) => {
  const itemId = requireString(req.body?.itemId, "itemId and candidateId are required");
  const candidateId = requireString(req.body?.candidateId, "itemId and candidateId are required");
  res.json(await trashOrganizeSelections([{ itemId, candidateId }]));
}));

organizeRouter.post("/organize/trash/bulk", mutation(async (req, res) => {
  const rawSelections: unknown[] = Array.isArray(req.body?.selections) ? req.body.selections : [];
  const selections: OrganizeTrashSelection[] = rawSelections
    .map((selection) => {
      const bodySelection = selection as Partial<OrganizeTrashSelection> | null;
      return {
        itemId: String(bodySelection?.itemId || ""),
        candidateId: String(bodySelection?.candidateId || "")
      };
    })
    .filter((selection) => selection.itemId && selection.candidateId);

  if (selections.length === 0) {
    throw new HttpError(400, "selections are required");
  }

  res.json(await trashOrganizeSelections(selections));
}));

organizeRouter.get("/duplicates", route(async (_req, res) => {
  const evaluation = await getOrganizeEvaluation(await loadCatalog(), await loadSettings());

  if (!evaluation.workflow.duplicateScanReady) {
    throw new HttpError(409, evaluation.workflow.message, { workflow: evaluation.workflow });
  }

  res.json({ groups: buildDuplicateGroups(evaluation.tracks) });
}));

organizeRouter.post("/duplicates/resolve", mutation(async (req, res) => {
  const keepId = String(req.body?.keepId || "");
  const removeIds = stringList(req.body?.removeIds);

  if (!keepId || removeIds.length === 0) {
    throw new HttpError(400, "keepId and removeIds are required");
  }

  const { catalog, settings } = await loadDuplicateCleanupContext();
  const result = await resolveDuplicates(settings, catalog.tracks, keepId, removeIds);

  await saveCatalog(result.tracks);
  invalidateOrganizeEvaluationCache();
  res.json({
    keptId: result.keptId,
    trashed: result.trashed,
    errors: result.errors
  });
}));

organizeRouter.post("/duplicates/resolve/bulk", mutation(async (req, res) => {
  const removeIds = requireList(req.body?.removeIds, "removeIds are required");
  const { catalog, settings } = await loadDuplicateCleanupContext();
  const result = await resolveSelectedDuplicates(settings, catalog.tracks, removeIds);

  await saveCatalog(result.tracks);
  invalidateOrganizeEvaluationCache();
  res.json({
    trashed: result.trashed,
    removedTrackIds: result.removedTrackIds,
    errors: result.errors
  });
}));

async function saveAndReplan(tracks: TrackFile[], settings: PrivateSettings) {
  const latestCatalog = await saveCatalog(tracks);
  invalidateOrganizeEvaluationCache();
  return (await rebuildOrganizeEvaluation(latestCatalog, settings)).plan;
}

async function rememberUserConfirmedTracks(tracks: TrackFile[], updatedTrackIds: string[], source: "spotify" | "trusted-path") {
  const updatedIds = new Set(updatedTrackIds);
  const updated = tracks.filter((track) => updatedIds.has(track.id));
  await saveMetadataOverridesForTracks(updated, source);
  await rememberConfirmedTrackIdentities(updated, source);
}

async function trashOrganizeSelections(selections: OrganizeTrashSelection[]) {
  const catalog = await loadCatalog();
  const settings = await loadSettings();
  const planned = await getOrganizeEvaluation(catalog, settings);
  const result = await trashOrganizeCandidates(settings, planned.tracks, selections);

  return {
    trashed: result.trashed,
    removedTrackIds: result.removedTrackIds,
    errors: result.errors,
    plan: await saveAndReplan(result.tracks, settings)
  };
}

async function loadDuplicateCleanupContext(): Promise<{ catalog: Catalog; settings: PrivateSettings }> {
  const catalog = await loadCatalog();
  const settings = await loadSettings();
  const workflow = await buildWorkflowState(catalog, settings);

  if (!workflow.duplicateScanReady) {
    throw new HttpError(409, workflow.message, { workflow });
  }

  return { catalog, settings };
}
