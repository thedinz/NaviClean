import { Router } from "express";
import type { NavidromeScanStatus, SettingsUpdate } from "../../shared/types.js";
import { HttpError, route } from "../http.js";
import { getNavidromeScanStatus, startNavidromeScan, testNavidromeConnection } from "../navidrome.js";
import { scheduleAutoScan } from "../scan-service.js";
import { loadSettings, SettingsValidationError, toSettingsView, updateSettings, type PrivateSettings } from "../settings.js";

export const settingsRouter = Router();

settingsRouter.get("/settings", route(async (_req, res) => {
  res.json(toSettingsView(await loadSettings()));
}));

settingsRouter.put("/settings", route(async (req, res) => {
  let next: PrivateSettings;

  try {
    next = await updateSettings(req.body as SettingsUpdate);
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }

  scheduleAutoScan(next);
  res.json(toSettingsView(next));
}));

settingsRouter.post("/navidrome/test", route(async (req, res) => {
  res.json(await testNavidromeConnection(await loadSettings(), req.body));
}));

settingsRouter.get("/navidrome/scan/status", route(async (_req, res) => {
  const settings = await loadSettings();

  try {
    res.json(await getNavidromeScanStatus(settings));
  } catch (error) {
    res.json(navidromeScanErrorStatus(settings, (error as Error).message));
  }
}));

settingsRouter.post("/navidrome/scan/start", route(async (req, res) => {
  const fullScan = Boolean(req.body?.fullScan);
  res.status(202).json(await startNavidromeScan(await loadSettings(), { fullScan }));
}));

function navidromeScanErrorStatus(settings: PrivateSettings, message: string): NavidromeScanStatus {
  return {
    configured: Boolean(
      settings.navidrome.baseUrl.trim() &&
        settings.navidrome.username.trim() &&
        settings.navidrome.password.trim()
    ),
    running: false,
    count: 0,
    folderCount: 0,
    lastScan: null,
    error: message,
    scanType: null,
    elapsedSeconds: null
  };
}
