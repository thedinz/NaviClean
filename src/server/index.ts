import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScanStatus, SettingsUpdate } from "../shared/types.js";
import { clearSessionCookie, getAuthInfo, login, logout, requireAuth, setSessionCookie } from "./auth.js";
import { createStats, loadCatalog, saveCatalog } from "./catalog.js";
import { buildDuplicateGroups, resolveDuplicates } from "./duplicates.js";
import { applyOrganizePlan, buildOrganizePlan } from "./organizer.js";
import { scanLibrary } from "./scanner.js";
import { loadSettings, toSettingsView, updateSettings } from "./settings.js";
import { testNavidromeConnection } from "./navidrome.js";

const app = express();
const port = Number(process.env.PORT || 8080);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const scanStatus: ScanStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  scannedFiles: 0,
  audioFiles: 0,
  errors: []
};

app.use(express.json({ limit: "2mb" }));

app.get("/api/auth/me", asyncHandler(async (req, res) => {
  res.json(await getAuthInfo(req));
}));

app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const token = await login(String(req.body.username || ""), String(req.body.password || ""));

  if (!token) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  setSessionCookie(res, token);
  res.json({
    authEnabled: true,
    authenticated: true,
    username: String(req.body.username || "")
  });
}));

app.post("/api/auth/logout", asyncHandler(async (req, res) => {
  logout(req);
  clearSessionCookie(res);
  res.json({ ok: true });
}));

app.use("/api", requireAuth);

app.get("/api/settings", asyncHandler(async (_req, res) => {
  res.json(toSettingsView(await loadSettings()));
}));

app.put("/api/settings", asyncHandler(async (req, res) => {
  const next = await updateSettings(req.body as SettingsUpdate);
  res.json(toSettingsView(next));
}));

app.post("/api/navidrome/test", asyncHandler(async (req, res) => {
  const settings = await loadSettings();
  res.json(await testNavidromeConnection(settings, req.body));
}));

app.get("/api/scan/status", (_req, res) => {
  res.json(scanStatus);
});

app.post("/api/scan/start", asyncHandler(async (_req, res) => {
  if (scanStatus.running) {
    res.status(409).json(scanStatus);
    return;
  }

  Object.assign(scanStatus, {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    scannedFiles: 0,
    audioFiles: 0,
    errors: []
  });

  void runScan();
  res.status(202).json(scanStatus);
}));

app.get("/api/tracks", asyncHandler(async (req, res) => {
  const catalog = await loadCatalog();
  const search = String(req.query.search || "").toLowerCase().trim();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
  const tracks = catalog.tracks
    .filter((track) => {
      if (!search) {
        return true;
      }
      return [track.artist, track.albumArtist, track.album, track.title, track.relativePath]
        .join(" ")
        .toLowerCase()
        .includes(search);
    })
    .slice(0, limit);

  res.json({ tracks, total: catalog.tracks.length });
}));

app.get("/api/duplicates", asyncHandler(async (_req, res) => {
  const catalog = await loadCatalog();
  res.json({ groups: buildDuplicateGroups(catalog.tracks) });
}));

app.get("/api/stats", asyncHandler(async (_req, res) => {
  const catalog = await loadCatalog();
  const groups = buildDuplicateGroups(catalog.tracks);
  const duplicateTracks = groups.reduce((total, group) => total + group.tracks.length, 0);
  res.json(createStats(catalog.tracks, groups.length, duplicateTracks, catalog.updatedAt));
}));

app.post("/api/organize/preview", asyncHandler(async (_req, res) => {
  const catalog = await loadCatalog();
  const settings = await loadSettings();
  res.json(await buildOrganizePlan(catalog.tracks, settings));
}));

app.post("/api/organize/apply", asyncHandler(async (_req, res) => {
  const catalog = await loadCatalog();
  const settings = await loadSettings();
  const plan = await buildOrganizePlan(catalog.tracks, settings);
  const result = await applyOrganizePlan(plan);

  if (result.moved > 0) {
    const movedById = new Map(result.items.filter((item) => item.applied).map((item) => [item.id, item]));
    const tracks = catalog.tracks.map((track) => {
      const moved = movedById.get(track.id);
      if (!moved) {
        return track;
      }
      return {
        ...track,
        absolutePath: moved.targetPath,
        relativePath: moved.targetRelativePath
      };
    });
    await saveCatalog(tracks);
  }

  res.json(result);
}));

app.post("/api/duplicates/resolve", asyncHandler(async (req, res) => {
  const keepId = String(req.body.keepId || "");
  const removeIds = Array.isArray(req.body.removeIds) ? req.body.removeIds.map(String) : [];

  if (!keepId || removeIds.length === 0) {
    res.status(400).json({ error: "keepId and removeIds are required" });
    return;
  }

  const catalog = await loadCatalog();
  const settings = await loadSettings();
  res.json(await resolveDuplicates(settings, catalog.tracks, keepId, removeIds));
}));

if (process.env.NODE_ENV === "production") {
  const clientDir = path.resolve(__dirname, "../../client");
  app.use(express.static(clientDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error.message });
});

app.listen(port, () => {
  console.log(`NaviClean listening on ${port}`);
});

async function runScan() {
  try {
    const settings = await loadSettings();
    const result = await scanLibrary(settings, (update) => {
      Object.assign(scanStatus, update);
    });
    scanStatus.errors = result.errors;
  } catch (error) {
    scanStatus.errors = [(error as Error).message];
  } finally {
    scanStatus.running = false;
    scanStatus.finishedAt = new Date().toISOString();
  }
}

function asyncHandler(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    handler(req, res, next).catch(next);
  };
}
