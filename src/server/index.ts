import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flagDefaultPassword, pruneExpiredSessions, requireAuth } from "./auth.js";
import { publishEngineStatus, setEngineStatusSettingsLoader, startBackgroundWork } from "./engine/background.js";
import { initializeDownloadEngine } from "./engine/jobs.js";
import { subscribe } from "./events.js";
import { errorHandler } from "./http.js";
import { pruneHttpCache } from "./http-cache.js";
import { invalidateOrganizeEvaluationCache } from "./organize-service.js";
import { authRouter } from "./routes/auth.js";
import { registerEngineRoutes } from "./routes/engine.js";
import { libraryRouter } from "./routes/library.js";
import { organizeRouter } from "./routes/organize.js";
import { recycleBinRouter } from "./routes/recycle-bin.js";
import { scanRouter } from "./routes/scan.js";
import { settingsRouter } from "./routes/settings.js";
import { spotifyRouter } from "./routes/spotify.js";
import { getScanStatus, scheduleAutoScan } from "./scan-service.js";
import { loadSettings } from "./settings.js";

const app = express();
const port = Number(process.env.PORT || 8080);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.set("trust proxy", trustProxySetting());
app.use(express.json({ limit: "2mb" }));

app.use("/api", authRouter);
app.use("/api", requireAuth);
app.use("/api", settingsRouter, spotifyRouter, scanRouter, libraryRouter, organizeRouter, recycleBinRouter);
registerEngineRoutes(app, loadSettings, () => [{ type: "scan", status: getScanStatus() }]);

if (process.env.NODE_ENV === "production") {
  const clientDir = path.resolve(__dirname, "../../client");
  app.use(express.static(clientDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

app.use(errorHandler);

app.listen(port, () => {
  console.log(`NaviClean listening on ${port}`);
  void loadSettings()
    .then(scheduleAutoScan)
    .catch((error) => console.error("Failed to schedule daily scan:", error));
  void flagDefaultPassword().catch((error) => console.error("Failed to check the default password:", error));
  pruneExpiredSessions();
  pruneHttpCache();
  initializeDownloadEngine(loadSettings);
  setEngineStatusSettingsLoader(loadSettings);
  startBackgroundWork(loadSettings);
});

// Library changes made by the download engine invalidate the cached organize plan.
subscribe((event) => {
  if (event.type === "catalog-changed") {
    invalidateOrganizeEvaluationCache();
  }
  if (
    event.type === "download-job" &&
    (event.job.status === "review" || event.job.status === "completed" || event.job.status === "partial" || event.job.status === "failed")
  ) {
    void publishEngineStatus();
  }
});

function trustProxySetting() {
  const value = (process.env.NAVICLEAN_TRUST_PROXY || "1").trim().toLowerCase();

  if (value === "false" || value === "0") {
    return false;
  }

  if (value === "true") {
    return true;
  }

  const hops = Number.parseInt(value, 10);
  return Number.isFinite(hops) && hops > 0 ? hops : 1;
}
