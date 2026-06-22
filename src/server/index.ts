import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OrganizePlan, OrganizeTrashSelection, ScanStatus, SettingsUpdate, WorkflowState } from "../shared/types.js";
import { clearSessionCookie, getAuthInfo, login, logout, requireAuth, setSessionCookie } from "./auth.js";
import { createStats, loadCatalog, saveCatalog } from "./catalog.js";
import { buildDuplicateGroups, resolveDuplicates, resolveSelectedDuplicates } from "./duplicates.js";
import { applyOrganizePlan, buildOrganizePlan, trashOrganizeCandidate, trashOrganizeCandidates } from "./organizer.js";
import { deleteRecycleBinItems, emptyRecycleBin, listRecycleBin } from "./recycle-bin.js";
import { scanLibrary } from "./scanner.js";
import { loadSettings, toSettingsView, updateSettings } from "./settings.js";
import { testNavidromeConnection } from "./navidrome.js";

const app = express();
const port = Number(process.env.PORT || 8080);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.set("trust proxy", trustProxySetting());

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

  setSessionCookie(req, res, token);
  res.json({
    authEnabled: true,
    authenticated: true,
    username: String(req.body.username || "")
  });
}));

app.post("/api/auth/logout", asyncHandler(async (req, res) => {
  logout(req);
  clearSessionCookie(req, res);
  res.json({ ok: true });
}));

app.use("/api", requireAuth);

app.get("/api/settings", asyncHandler(async (_req, res) => {
  res.json(toSettingsView(await loadSettingsForPlanning()));
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
    res.status(202).json(scanStatus);
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
  const settings = await loadSettingsForPlanning();
  const workflow = await buildWorkflowState(catalog, settings);

  if (!workflow.duplicateScanReady) {
    res.status(409).json({ error: workflow.message, workflow });
    return;
  }

  res.json({ groups: buildDuplicateGroups(catalog.tracks) });
}));

app.get("/api/stats", asyncHandler(async (_req, res) => {
  const catalog = await loadCatalog();

  if (scanStatus.running) {
    const workflow = workflowStateDuringScan(catalog.updatedAt);
    res.json(createStats(catalog.tracks, 0, 0, catalog.updatedAt, workflow));
    return;
  }

  const settings = await loadSettingsForPlanning();
  const workflow = await buildWorkflowState(catalog, settings);
  const groups = workflow.duplicateScanReady ? buildDuplicateGroups(catalog.tracks) : [];
  const duplicateTracks = groups.reduce((total, group) => total + group.tracks.length, 0);
  res.json(createStats(catalog.tracks, groups.length, duplicateTracks, catalog.updatedAt, workflow));
}));

app.get("/api/recycle-bin", asyncHandler(async (_req, res) => {
  res.json(await listRecycleBin(await loadSettingsForPlanning()));
}));

app.delete("/api/recycle-bin", asyncHandler(async (_req, res) => {
  res.json(await emptyRecycleBin(await loadSettingsForPlanning()));
}));

app.delete("/api/recycle-bin/items", asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String).filter(Boolean) : [];

  if (ids.length === 0) {
    res.status(400).json({ error: "ids are required" });
    return;
  }

  res.json(await deleteRecycleBinItems(await loadSettingsForPlanning(), ids));
}));

app.post("/api/organize/preview", asyncHandler(async (_req, res) => {
  const catalog = await loadCatalog();
  const settings = await loadSettingsForPlanning();
  res.json(await buildOrganizePlan(catalog.tracks, settings));
}));

app.post("/api/organize/apply", asyncHandler(async (_req, res) => {
  const catalog = await loadCatalog();
  const settings = await loadSettingsForPlanning();
  const plan = await buildOrganizePlan(catalog.tracks, settings);
  const result = await applyOrganizePlan(plan);
  let tracks = catalog.tracks;

  if (result.moved > 0) {
    const movedById = new Map(result.items.filter((item) => item.applied).map((item) => [item.id, item]));
    tracks = catalog.tracks.map((track) => {
      const moved = movedById.get(track.id);
      if (!moved) {
        return track;
      }
      return {
        ...track,
        absolutePath: moved.targetPath,
        relativePath: moved.targetRelativePath,
        targetPath: moved.targetPath,
        targetRelativePath: moved.targetRelativePath
      };
    });
    await saveCatalog(tracks);
  }

  res.json({ ...result, plan: await buildOrganizePlan(tracks, settings) });
}));

app.post("/api/organize/trash", asyncHandler(async (req, res) => {
  const itemId = String(req.body.itemId || "");
  const candidateId = String(req.body.candidateId || "");

  if (!itemId || !candidateId) {
    res.status(400).json({ error: "itemId and candidateId are required" });
    return;
  }

  const catalog = await loadCatalog();
  const settings = await loadSettingsForPlanning();
  const result = await trashOrganizeCandidate(settings, catalog.tracks, itemId, candidateId);

  await saveCatalog(result.tracks);
  res.json({
    trashed: result.trashed,
    removedTrackIds: result.removedTrackIds,
    errors: result.errors,
    plan: result.plan
  });
}));

app.post("/api/organize/trash/bulk", asyncHandler(async (req, res) => {
  const rawSelections: unknown[] = Array.isArray(req.body.selections) ? req.body.selections : [];
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
    res.status(400).json({ error: "selections are required" });
    return;
  }

  const catalog = await loadCatalog();
  const settings = await loadSettingsForPlanning();
  const result = await trashOrganizeCandidates(settings, catalog.tracks, selections);

  await saveCatalog(result.tracks);
  res.json({
    trashed: result.trashed,
    removedTrackIds: result.removedTrackIds,
    errors: result.errors,
    plan: result.plan
  });
}));

app.post("/api/duplicates/resolve", asyncHandler(async (req, res) => {
  const keepId = String(req.body.keepId || "");
  const removeIds = Array.isArray(req.body.removeIds) ? req.body.removeIds.map(String) : [];

  if (!keepId || removeIds.length === 0) {
    res.status(400).json({ error: "keepId and removeIds are required" });
    return;
  }

  const catalog = await loadCatalog();
  const settings = await loadSettingsForPlanning();
  const workflow = await buildWorkflowState(catalog, settings);

  if (!workflow.duplicateScanReady) {
    res.status(409).json({ error: workflow.message, workflow });
    return;
  }

  const result = await resolveDuplicates(settings, catalog.tracks, keepId, removeIds);

  await saveCatalog(result.tracks);
  res.json({
    keptId: result.keptId,
    trashed: result.trashed,
    errors: result.errors
  });
}));

app.post("/api/duplicates/resolve/bulk", asyncHandler(async (req, res) => {
  const removeIds = Array.isArray(req.body.removeIds) ? req.body.removeIds.map(String).filter(Boolean) : [];

  if (removeIds.length === 0) {
    res.status(400).json({ error: "removeIds are required" });
    return;
  }

  const catalog = await loadCatalog();
  const settings = await loadSettingsForPlanning();
  const workflow = await buildWorkflowState(catalog, settings);

  if (!workflow.duplicateScanReady) {
    res.status(409).json({ error: workflow.message, workflow });
    return;
  }

  const result = await resolveSelectedDuplicates(settings, catalog.tracks, removeIds);

  await saveCatalog(result.tracks);
  res.json({
    trashed: result.trashed,
    removedTrackIds: result.removedTrackIds,
    errors: result.errors
  });
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

async function runScan() {
  try {
    const settings = await loadSettingsForPlanning();
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

async function loadSettingsForPlanning() {
  return loadSettings();
}

function asyncHandler(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

async function buildWorkflowState(
  catalog: Awaited<ReturnType<typeof loadCatalog>>,
  settings: Awaited<ReturnType<typeof loadSettings>>
): Promise<WorkflowState> {
  const plan = await buildOrganizePlan(catalog.tracks, settings);
  return workflowStateFromPlan(catalog.updatedAt, catalog.tracks.length, plan);
}

function workflowStateFromPlan(
  lastScanFinishedAt: string | null,
  totalTracks: number,
  plan: OrganizePlan
): WorkflowState {
  const pendingMoves = plan.summary.ready;
  const organizationConflicts = plan.summary.conflicts;
  const missingFiles = plan.summary.missing;
  const scanned = Boolean(lastScanFinishedAt);
  const warnings = [
    "Duplicate cleanup is intentionally conservative and only unlocks after organization is complete.",
    "Different albums, compilations, live versions, acoustic versions, and best-of releases should remain separate."
  ];

  if (!scanned) {
    return {
      stage: "scan",
      duplicateScanReady: false,
      scanned,
      pendingMoves,
      organizationConflicts,
      missingFiles,
      message: "Stage 1: scan the mounted Navidrome library before organizing or finding duplicates.",
      warnings
    };
  }

  if (totalTracks === 0) {
    return {
      stage: "scan",
      duplicateScanReady: false,
      scanned,
      pendingMoves,
      organizationConflicts,
      missingFiles,
      message: "No audio files are in the current catalog. Check the library path and scan again.",
      warnings
    };
  }

  if (pendingMoves > 0 || organizationConflicts > 0 || missingFiles > 0) {
    return {
      stage: "organize",
      duplicateScanReady: false,
      scanned,
      pendingMoves,
      organizationConflicts,
      missingFiles,
      message: `Stage 2: finish organizing first (${pendingMoves} moves, ${organizationConflicts} conflicts, ${missingFiles} missing files).`,
      warnings
    };
  }

  return {
    stage: "duplicates",
    duplicateScanReady: true,
    scanned,
    pendingMoves,
    organizationConflicts,
    missingFiles,
    message: "Stage 3: duplicate cleanup is available for same-release track matches only.",
    warnings
  };
}

function workflowStateDuringScan(lastScanFinishedAt: string | null): WorkflowState {
  return {
    stage: "scan",
    duplicateScanReady: false,
    scanned: Boolean(lastScanFinishedAt),
    pendingMoves: 0,
    organizationConflicts: 0,
    missingFiles: 0,
    message: "Stage 1: scan is running. Organization and duplicate cleanup unlock after the scan finishes.",
    warnings: [
      "Duplicate cleanup is intentionally conservative and only unlocks after organization is complete.",
      "Different albums, compilations, live versions, acoustic versions, and best-of releases should remain separate."
    ]
  };
}
