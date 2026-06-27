import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OrganizePlan, OrganizeTrashSelection, ScanStatus, SettingsUpdate, TrackFile, WorkflowState } from "../shared/types.js";
import { clearSessionCookie, getAuthInfo, login, logout, requireAuth, setSessionCookie } from "./auth.js";
import { createStats, loadCatalog, saveCatalog } from "./catalog.js";
import { buildDuplicateGroups, resolveDuplicates, resolveSelectedDuplicates } from "./duplicates.js";
import {
  buildLibraryAlbums,
  buildLibraryArtists,
  findLibraryAlbumTracks,
  findLibraryArtistTracks,
  trashLibraryTracks
} from "./library.js";
import { applyOrganizePlan, buildOrganizePlan, trashOrganizeCandidate, trashOrganizeCandidates } from "./organizer.js";
import {
  getSpotifyCatalogDownloadJob,
  previewSpotifyCatalogDownloads,
  startSpotifyCatalogDownloadJob
} from "./providers.js";
import { deleteRecycleBinItems, emptyRecycleBin, listRecycleBin } from "./recycle-bin.js";
import { scanLibrary } from "./scanner.js";
import { loadSettings, toSettingsView, updateSettings } from "./settings.js";
import { fetchNavidromeArtwork, testNavidromeConnection } from "./navidrome.js";
import {
  buildSpotifyDownloadPlan,
  enrichTracksWithSpotifyOrganizeMetadata,
  getSpotifyAlbumDetail,
  getSpotifyArtistDiscography,
  matchLibraryArtistsToSpotify,
  searchSpotifyArtists,
  testSpotifyConnection
} from "./spotify.js";
import type { SpotifyOrganizeEnrichmentOptions } from "./spotify.js";

const app = express();
const port = Number(process.env.PORT || 8080);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultLibraryArtistPageSize = 25;
const maxLibraryArtistPageSize = 100;
app.set("trust proxy", trustProxySetting());

type CatalogSnapshot = Awaited<ReturnType<typeof loadCatalog>>;
type PlanningSettings = Awaited<ReturnType<typeof loadSettings>>;
type OrganizeEvaluation = {
  key: string;
  plan: OrganizePlan;
  tracks: TrackFile[];
  workflow: WorkflowState;
};

const scanStatus: ScanStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  scannedFiles: 0,
  audioFiles: 0,
  errors: []
};
let autoScanTimer: NodeJS.Timeout | null = null;
let cachedOrganizeEvaluation: OrganizeEvaluation | null = null;
let pendingOrganizeEvaluation: { key: string; promise: Promise<OrganizeEvaluation> } | null = null;

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
app.use("/api/organize", (_req, res, next) => {
  res.set("Cache-Control", "no-store, max-age=0");
  next();
});

app.get("/api/settings", asyncHandler(async (_req, res) => {
  res.json(toSettingsView(await loadSettingsForPlanning()));
}));

app.put("/api/settings", asyncHandler(async (req, res) => {
  const next = await updateSettings(req.body as SettingsUpdate);
  scheduleAutoScan(next);
  res.json(toSettingsView(next));
}));

app.post("/api/navidrome/test", asyncHandler(async (req, res) => {
  const settings = await loadSettings();
  res.json(await testNavidromeConnection(settings, req.body));
}));

app.post("/api/spotify/test", asyncHandler(async (req, res) => {
  const settings = await loadSettings();
  res.json(await testSpotifyConnection(settings, req.body));
}));

app.get("/api/spotify/artists/search", asyncHandler(async (req, res) => {
  res.json({
    artists: await searchSpotifyArtists(await loadSettingsForPlanning(), String(req.query.query || ""))
  });
}));

app.get("/api/spotify/library-artists", asyncHandler(async (req, res) => {
  const catalog = await loadCatalog();
  const settings = await loadSettingsForPlanning();
  const artists = buildLibraryArtists(catalog.tracks, String(req.query.search || ""));
  const limit = Number(req.query.limit || 12);

  res.json({
    matches: await matchLibraryArtistsToSpotify(
      settings,
      artists.map((artist) => ({ id: artist.id, name: artist.name })),
      Number.isFinite(limit) ? limit : 12
    )
  });
}));

app.get("/api/spotify/artists/:artistId/discography", asyncHandler(async (req, res) => {
  const catalog = await loadCatalog();
  const settings = await loadSettingsForPlanning();

  res.json(await getSpotifyArtistDiscography(settings, catalog.tracks, String(req.params.artistId)));
}));

app.get("/api/spotify/albums/:albumId", asyncHandler(async (req, res) => {
  const catalog = await loadCatalog();
  const settings = await loadSettingsForPlanning();

  res.json({
    album: await getSpotifyAlbumDetail(settings, catalog.tracks, String(req.params.albumId))
  });
}));

app.post("/api/spotify/download-plan", asyncHandler(async (req, res) => {
  const albumId = String(req.body.spotifyAlbumId || "");

  if (!albumId) {
    res.status(400).json({ error: "spotifyAlbumId is required" });
    return;
  }

  const catalog = await loadCatalog();
  const settings = await loadSettingsForPlanning();

  res.json({
    plan: await buildSpotifyDownloadPlan(
      settings,
      catalog.tracks,
      albumId,
      Array.isArray(req.body.trackIds) ? req.body.trackIds.map(String) : undefined
    )
  });
}));

app.post("/api/spotify/download-preview", asyncHandler(async (req, res) => {
  const albumId = String(req.body.spotifyAlbumId || "");

  if (!albumId) {
    res.status(400).json({ error: "spotifyAlbumId is required" });
    return;
  }

  const catalog = await loadCatalog();
  const settings = await loadSettingsForPlanning();

  res.json({
    preview: await previewSpotifyCatalogDownloads(
      settings,
      catalog.tracks,
      albumId,
      Array.isArray(req.body.trackIds) ? req.body.trackIds.map(String) : undefined
    )
  });
}));

app.post("/api/spotify/download-jobs", asyncHandler(async (req, res) => {
  const albumId = String(req.body.spotifyAlbumId || "");

  if (!albumId) {
    res.status(400).json({ error: "spotifyAlbumId is required" });
    return;
  }

  const catalog = await loadCatalog();
  const settings = await loadSettingsForPlanning();

  res.json(await startSpotifyCatalogDownloadJob({
    albumId,
    bulkRiskAccepted: Boolean(req.body.bulkRiskAccepted),
    localTracks: catalog.tracks,
    rightsConfirmed: Boolean(req.body.rightsConfirmed),
    settings,
    trackIds: Array.isArray(req.body.trackIds) ? req.body.trackIds.map(String) : undefined
  }));
}));

app.get("/api/spotify/download-jobs/:jobId", (req, res) => {
  const job = getSpotifyCatalogDownloadJob(String(req.params.jobId));

  if (!job) {
    res.status(404).json({ error: "Download job not found" });
    return;
  }

  res.json({ job });
});

app.get("/api/scan/status", (_req, res) => {
  res.json(scanStatus);
});

app.post("/api/scan/start", asyncHandler(async (_req, res) => {
  if (!startBackgroundScan()) {
    res.status(202).json(scanStatus);
    return;
  }

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

app.get("/api/library/artists", asyncHandler(async (req, res) => {
  const catalog = await loadCatalog();
  const pageSize = clampPositiveInteger(
    Number(req.query.pageSize || defaultLibraryArtistPageSize),
    defaultLibraryArtistPageSize,
    1,
    maxLibraryArtistPageSize
  );
  const requestedPage = clampPositiveInteger(Number(req.query.page || 1), 1, 1, Number.MAX_SAFE_INTEGER);
  const artists = buildLibraryArtists(catalog.tracks, String(req.query.search || ""));
  const pageCount = Math.max(1, Math.ceil(artists.length / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const start = (page - 1) * pageSize;

  res.json({
    artists: artists.slice(start, start + pageSize),
    artistTotal: artists.length,
    page,
    pageSize,
    total: catalog.tracks.length
  });
}));

app.get("/api/library/artwork/:type", asyncHandler(async (req, res) => {
  const type = String(req.params.type || "");
  const artist = String(req.query.artist || "").trim();
  const album = String(req.query.album || "").trim();
  const year = String(req.query.year || "").trim();
  const size = clampArtworkSize(Number(req.query.size || 360));

  if (type !== "artist" && type !== "album") {
    res.status(400).json({ error: "Artwork type must be artist or album." });
    return;
  }

  if (!artist || (type === "album" && !album)) {
    res.status(400).json({ error: "Artwork lookup is missing artist or album metadata." });
    return;
  }

  const artwork = await fetchNavidromeArtwork(
    await loadSettingsForPlanning(),
    type === "album" ? { type, artist, album, year } : { type, artist },
    size
  );

  if (!artwork) {
    res.status(404).end();
    return;
  }

  res.setHeader("Cache-Control", "private, max-age=86400");
  res.type(artwork.contentType);
  res.send(artwork.data);
}));

app.get("/api/library/artists/:artistId/albums", asyncHandler(async (req, res) => {
  const catalog = await loadCatalog();
  const artistId = String(req.params.artistId || "");
  const albums = buildLibraryAlbums(catalog.tracks, artistId, String(req.query.search || ""));

  if (!albums) {
    res.status(404).json({ error: "Artist is no longer in the catalog. Scan or refresh before continuing." });
    return;
  }

  res.json({ albums });
}));

app.get("/api/library/artists/:artistId/albums/:albumId/tracks", asyncHandler(async (req, res) => {
  const catalog = await loadCatalog();
  const artistId = String(req.params.artistId || "");
  const albumId = String(req.params.albumId || "");
  const tracks = findLibraryAlbumTracks(catalog.tracks, artistId, albumId);

  if (!tracks) {
    res.status(404).json({ error: "Album is no longer in the catalog. Scan or refresh before continuing." });
    return;
  }

  res.json({ tracks });
}));

app.delete("/api/library/artists/:artistId", asyncHandler(async (req, res) => {
  const catalog = await loadCatalog();
  const artistId = String(req.params.artistId || "");
  const tracks = findLibraryArtistTracks(catalog.tracks, artistId);

  if (!tracks) {
    res.status(404).json({ error: "Artist is no longer in the catalog. Scan or refresh before continuing." });
    return;
  }

  const result = await trashLibraryTracks(await loadSettingsForPlanning(), catalog.tracks, tracks.map((track) => track.id));

  await saveCatalog(result.tracks);
  res.json(libraryTrashResponse(result));
}));

app.delete("/api/library/artists/:artistId/albums/:albumId", asyncHandler(async (req, res) => {
  const catalog = await loadCatalog();
  const artistId = String(req.params.artistId || "");
  const albumId = String(req.params.albumId || "");
  const tracks = findLibraryAlbumTracks(catalog.tracks, artistId, albumId);

  if (!tracks) {
    res.status(404).json({ error: "Album is no longer in the catalog. Scan or refresh before continuing." });
    return;
  }

  const result = await trashLibraryTracks(await loadSettingsForPlanning(), catalog.tracks, tracks.map((track) => track.id));

  await saveCatalog(result.tracks);
  res.json(libraryTrashResponse(result));
}));

app.delete("/api/library/tracks/:trackId", asyncHandler(async (req, res) => {
  const catalog = await loadCatalog();
  const trackId = String(req.params.trackId || "");
  const track = catalog.tracks.find((candidate) => candidate.id === trackId);

  if (!track) {
    res.status(404).json({ error: "Track is no longer in the catalog. Scan or refresh before continuing." });
    return;
  }

  const result = await trashLibraryTracks(await loadSettingsForPlanning(), catalog.tracks, [track.id]);

  await saveCatalog(result.tracks);
  res.json(libraryTrashResponse(result));
}));

app.get("/api/duplicates", asyncHandler(async (_req, res) => {
  const catalog = await loadCatalog();
  const settings = await loadSettingsForPlanning();
  const evaluation = await getOrganizeEvaluation(catalog, settings);
  const workflow = evaluation.workflow;

  if (!workflow.duplicateScanReady) {
    res.status(409).json({ error: workflow.message, workflow });
    return;
  }

  res.json({ groups: buildDuplicateGroups(evaluation.tracks) });
}));

app.get("/api/stats", asyncHandler(async (_req, res) => {
  const catalog = await loadCatalog();

  if (scanStatus.running) {
    const workflow = workflowStateDuringScan(catalog.updatedAt);
    res.json(createStats(catalog.tracks, 0, 0, catalog.updatedAt, workflow));
    return;
  }

  const settings = await loadSettingsForPlanning();
  const evaluation = await getOrganizeEvaluation(catalog, settings);
  const workflow = evaluation.workflow;
  const groups = workflow.duplicateScanReady ? buildDuplicateGroups(evaluation.tracks) : [];
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
  const quick = _req.query.quick === "1" || (_req.body as { quick?: boolean } | undefined)?.quick === true;
  const evaluation = quick
    ? await getOrganizeEvaluation(catalog, settings)
    : await buildAndCacheOrganizeEvaluation(catalog, settings);
  res.json(evaluation.plan);
}));

app.post("/api/organize/apply", asyncHandler(async (_req, res) => {
  const catalog = await loadCatalog();
  const settings = await loadSettingsForPlanning();
  const planned = await getOrganizeEvaluation(catalog, settings);
  const plan = planned.plan;
  const result = await applyOrganizePlan(plan);
  let tracks = planned.tracks;
  let latestCatalog = catalog;

  if (result.moved > 0) {
    const movedById = new Map(result.items.filter((item) => item.applied).map((item) => [item.id, item]));
    tracks = planned.tracks.map((track) => {
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
    latestCatalog = await saveCatalog(tracks);
  }

  const refreshed = await getOrganizeEvaluation({ ...latestCatalog, tracks }, settings);
  res.json({ ...result, plan: refreshed.plan });
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
  const planned = await getOrganizeEvaluation(catalog, settings);
  const result = await trashOrganizeCandidate(settings, planned.tracks, itemId, candidateId);
  const savedCatalog = await saveCatalog(result.tracks);
  const refreshed = await getOrganizeEvaluation(savedCatalog, settings);

  res.json({
    trashed: result.trashed,
    removedTrackIds: result.removedTrackIds,
    errors: result.errors,
    plan: refreshed.plan
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
  const planned = await getOrganizeEvaluation(catalog, settings);
  const result = await trashOrganizeCandidates(settings, planned.tracks, selections);
  const savedCatalog = await saveCatalog(result.tracks);
  const refreshed = await getOrganizeEvaluation(savedCatalog, settings);

  res.json({
    trashed: result.trashed,
    removedTrackIds: result.removedTrackIds,
    errors: result.errors,
    plan: refreshed.plan
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
  void loadSettingsForPlanning()
    .then(scheduleAutoScan)
    .catch((error) => console.error("Failed to schedule daily scan:", error));
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

function libraryTrashResponse(result: Awaited<ReturnType<typeof trashLibraryTracks>>) {
  return {
    trashed: result.trashed,
    removedTrackIds: result.removedTrackIds,
    errors: result.errors
  };
}

function clampArtworkSize(value: number) {
  if (!Number.isFinite(value)) {
    return 360;
  }

  return Math.max(96, Math.min(720, Math.round(value)));
}

function clampPositiveInteger(value: number, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.floor(value)));
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

function startBackgroundScan() {
  if (scanStatus.running) {
    return false;
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
  return true;
}

function scheduleAutoScan(settings: Awaited<ReturnType<typeof loadSettings>>) {
  clearAutoScanTimer();

  if (!settings.scan.autoScanEnabled) {
    return;
  }

  const nextScanAt = nextDailyScanDate(settings.scan.autoScanTime);
  const delay = Math.max(0, nextScanAt.getTime() - Date.now());
  autoScanTimer = setTimeout(() => {
    void runScheduledScan();
  }, delay);
  console.log(`Daily scan scheduled for ${nextScanAt.toLocaleString()}`);
}

function clearAutoScanTimer() {
  if (!autoScanTimer) {
    return;
  }

  clearTimeout(autoScanTimer);
  autoScanTimer = null;
}

async function runScheduledScan() {
  autoScanTimer = null;

  try {
    const settings = await loadSettingsForPlanning();

    if (settings.scan.autoScanEnabled) {
      const started = startBackgroundScan();
      console.log(started ? "Starting scheduled daily scan." : "Skipping scheduled daily scan because another scan is running.");
    }

    scheduleAutoScan(settings);
  } catch (error) {
    console.error("Failed to start scheduled daily scan:", error);
  }
}

function nextDailyScanDate(time: string, from = new Date()) {
  const [hour = "2", minute = "0"] = time.split(":");
  const next = new Date(from);
  next.setHours(Number(hour), Number(minute), 0, 0);

  if (next.getTime() <= from.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

async function loadSettingsForPlanning() {
  return loadSettings();
}

async function buildSpotifyAwareOrganizePlan(
  tracks: Awaited<ReturnType<typeof loadCatalog>>["tracks"],
  settings: Awaited<ReturnType<typeof loadSettings>>,
  options?: SpotifyOrganizeEnrichmentOptions
) {
  const enriched = await enrichTracksWithSpotifyOrganizeMetadata(settings, tracks, options);
  const plan = await buildOrganizePlan(enriched.tracks, settings);

  return {
    tracks: enriched.tracks,
    plan: {
      ...plan,
      warnings: [...enriched.warnings, ...plan.warnings]
    } satisfies OrganizePlan
  };
}

async function getOrganizeEvaluation(catalog: CatalogSnapshot, settings: PlanningSettings): Promise<OrganizeEvaluation> {
  const key = organizeEvaluationKey(catalog, settings);

  if (cachedOrganizeEvaluation?.key === key) {
    return cachedOrganizeEvaluation;
  }

  const plan = await buildOrganizePlan(catalog.tracks, settings);
  const evaluation = organizeEvaluationFromPlan(key, catalog, catalog.tracks, plan);
  cachedOrganizeEvaluation = evaluation;
  return evaluation;
}

async function buildAndCacheOrganizeEvaluation(catalog: CatalogSnapshot, settings: PlanningSettings): Promise<OrganizeEvaluation> {
  const key = organizeEvaluationKey(catalog, settings);

  if (cachedOrganizeEvaluation?.key === key) {
    return cachedOrganizeEvaluation;
  }

  if (pendingOrganizeEvaluation?.key === key) {
    return pendingOrganizeEvaluation.promise;
  }

  const promise = (async () => {
    const { tracks, plan } = await buildSpotifyAwareOrganizePlan(catalog.tracks, settings);
    const evaluation = organizeEvaluationFromPlan(key, catalog, tracks, plan);
    cachedOrganizeEvaluation = evaluation;
    return evaluation;
  })();

  pendingOrganizeEvaluation = { key, promise };

  try {
    return await promise;
  } finally {
    if (pendingOrganizeEvaluation?.promise === promise) {
      pendingOrganizeEvaluation = null;
    }
  }
}

function organizeEvaluationFromPlan(
  key: string,
  catalog: CatalogSnapshot,
  tracks: TrackFile[],
  plan: OrganizePlan
): OrganizeEvaluation {
  return {
    key,
    plan,
    tracks,
    workflow: workflowStateFromPlan(catalog.updatedAt, catalog.tracks.length, plan)
  };
}

function organizeEvaluationKey(catalog: CatalogSnapshot, settings: PlanningSettings) {
  return JSON.stringify({
    catalogUpdatedAt: catalog.updatedAt,
    trackCount: catalog.tracks.length,
    naming: settings.naming,
    spotify: settings.catalog.spotify
  });
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
  return (await getOrganizeEvaluation(catalog, settings)).workflow;
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
      message: `Stage 2: review organization (${workflowBlockerSummary(pendingMoves, organizationConflicts, missingFiles)}).`,
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
    message: "Stage 3: organization is complete. Duplicate cleanup will show same-release matches when any are found.",
    warnings
  };
}

function workflowBlockerSummary(pendingMoves: number, organizationConflicts: number, missingFiles: number) {
  return [
    countLabel(pendingMoves, "move"),
    countLabel(organizationConflicts, "conflict"),
    countLabel(missingFiles, "missing file")
  ].filter(Boolean).join(", ");
}

function countLabel(count: number, noun: string) {
  if (count <= 0) {
    return "";
  }

  return `${count} ${noun}${count === 1 ? "" : "s"}`;
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
