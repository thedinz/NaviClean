import { Router } from "express";
import type { AudioConvertQuality, AudioConvertTargetFormat } from "../../shared/types.js";
import { createStats, loadCatalog } from "../catalog.js";
import { getActiveAudioConvertJob, getAudioConvertJob, listAudioConvertView, startAudioConvertJob } from "../converter.js";
import { buildDuplicateGroups } from "../duplicates.js";
import { HttpError, optionalStringList, route } from "../http.js";
import { getOrganizeEvaluation, invalidateOrganizeEvaluationCache, workflowStateDuringScan } from "../organize-service.js";
import { cancelScan, getScanStatus, isScanRunning, startBackgroundScan } from "../scan-service.js";
import { loadSettings } from "../settings.js";

export const scanRouter = Router();

scanRouter.get("/scan/status", route((_req, res) => {
  res.json(getScanStatus());
}));

scanRouter.post("/scan/start", route((_req, res) => {
  startBackgroundScan();
  res.status(202).json(getScanStatus());
}));

scanRouter.post("/scan/cancel", route((_req, res) => {
  cancelScan();
  res.status(202).json(getScanStatus());
}));

scanRouter.get("/stats", route(async (_req, res) => {
  const catalog = await loadCatalog();

  if (isScanRunning()) {
    res.json(createStats(catalog.tracks, 0, 0, catalog.updatedAt, workflowStateDuringScan(catalog.updatedAt)));
    return;
  }

  const evaluation = await getOrganizeEvaluation(catalog, await loadSettings());
  const groups = evaluation.workflow.duplicateScanReady ? buildDuplicateGroups(evaluation.tracks) : [];
  const duplicateTracks = groups.reduce((total, group) => total + group.tracks.length, 0);
  res.json(createStats(catalog.tracks, groups.length, duplicateTracks, catalog.updatedAt, evaluation.workflow));
}));

scanRouter.get("/convert", route(async (_req, res) => {
  res.json(await listAudioConvertView(await loadSettings()));
}));

scanRouter.get("/convert/jobs/active", route((_req, res) => {
  res.json({ job: getActiveAudioConvertJob() });
}));

scanRouter.post("/convert/jobs", route(async (req, res) => {
  if (getActiveAudioConvertJob()) {
    throw new HttpError(409, "A conversion job is already running. Wait for it to finish before starting another one.");
  }

  if (isScanRunning()) {
    throw new HttpError(409, "A library scan is running. Wait for it to finish before converting files.");
  }

  try {
    const job = await startAudioConvertJob({
      quality: String(req.body?.quality || "") as AudioConvertQuality,
      settings: await loadSettings(),
      sourceExtension: String(req.body?.sourceExtension || ""),
      targetFormat: String(req.body?.targetFormat || "") as AudioConvertTargetFormat,
      trackIds: optionalStringList(req.body?.trackIds)
    });

    invalidateOrganizeEvaluationCache();
    res.status(202).json({ job });
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}));

scanRouter.get("/convert/jobs/:jobId", route((req, res) => {
  const job = getAudioConvertJob(String(req.params.jobId || ""));

  if (!job) {
    throw new HttpError(404, "Conversion job not found.");
  }

  res.json({ job });
}));
