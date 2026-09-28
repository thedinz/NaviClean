import type express from "express";
import type { DownloadTrack, ServerEvent } from "../../shared/types.js";
import { loadCatalog } from "../catalog.js";
import {
  catalogArtist,
  catalogRelease,
  downloadTracksForRelease,
  downloadTracksFromSpotifyAlbum,
  searchCatalogArtists
} from "../catalog-browse.js";
import { engineStatus, publishEngineStatus, retryDueWanted, runBackgroundPass } from "../engine/background.js";
import {
  followArtist,
  listFollows,
  listReleases,
  markReleasesSeen,
  releaseCoverUrl,
  releaseDownloadRequest,
  setReleaseStatus,
  unfollowArtist,
  updateFollow
} from "../engine/follows.js";
import {
  approveReviewItem,
  cancelDownloadJob,
  clearFinishedJobs,
  createDownloadJob,
  EngineNotFoundError,
  getDownloadJob,
  listDownloadJobs,
  listReviewItems,
  rejectReviewItem,
  removeDownloadJob,
  researchItem,
  retryDownloadJob
} from "../engine/jobs.js";
import { listQuarantine, releaseQuarantine } from "../engine/quarantine.js";
import { downloadTrackFromLibraryTrack, listUpgradeCandidates } from "../engine/upgrades.js";
import { listWanted, removeWanted, retryWantedNow, setWantedPaused } from "../engine/wanted.js";
import { subscribe } from "../events.js";
import { coverArtUrl } from "../musicbrainz.js";
import type { PrivateSettings } from "../settings.js";
import { buildSpotifyDownloadPlan } from "../spotify.js";

type Handler = (req: express.Request, res: express.Response) => Promise<void>;

/** Download engine, MusicBrainz catalog, following, upgrades, and the live event stream. */
export function registerEngineRoutes(
  app: express.Express,
  loadSettings: () => Promise<PrivateSettings>,
  currentEvents: () => ServerEvent[]
) {
  const route = (handler: Handler) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    handler(req, res).catch((error) => {
      if (error instanceof EngineNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error instanceof ClientError) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    });
  };

  app.get("/api/events", (req, res) => {
    res.set({
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders();
    const send = (event: ServerEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of currentEvents()) {
      send(event);
    }
    const unsubscribe = subscribe(send);
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/api/engine/status", route(async (_req, res) => {
    res.json(await engineStatus(await loadSettings()));
  }));

  // Catalog (MusicBrainz)
  app.get("/api/catalog/artists", route(async (req, res) => {
    const catalog = await loadCatalog();
    res.json({ artists: await searchCatalogArtists(String(req.query.query || ""), catalog.tracks) });
  }));

  app.get("/api/catalog/artists/:artistId", route(async (req, res) => {
    const catalog = await loadCatalog();
    res.json(await catalogArtist(String(req.params.artistId), catalog.tracks));
  }));

  app.get("/api/catalog/release-groups/:releaseGroupId", route(async (req, res) => {
    const catalog = await loadCatalog();
    res.json(
      await catalogRelease(
        String(req.params.releaseGroupId),
        req.query.release ? String(req.query.release) : null,
        catalog.tracks,
        queuedTrackKeys()
      )
    );
  }));

  // Downloads
  app.get("/api/downloads", route(async (_req, res) => {
    res.json({ jobs: listDownloadJobs() });
  }));

  app.post("/api/downloads", route(async (req, res) => {
    if (req.body.rightsConfirmed !== true) {
      throw new ClientError("Confirm you are authorized to download the selected tracks first.");
    }
    const settings = await loadSettings();
    const catalogSource = req.body.catalog === "spotify" ? "spotify" : "musicbrainz";
    const trackIds = Array.isArray(req.body.trackIds) ? req.body.trackIds.map(String) : undefined;

    if (catalogSource === "musicbrainz") {
      const releaseId = String(req.body.releaseId || "");
      if (!releaseId) {
        throw new ClientError("releaseId is required.");
      }
      const { release, tracks } = await downloadTracksForRelease(releaseId, trackIds);
      const albumArtist = tracks[0]?.albumArtist ?? "";
      const job = await createDownloadJob({
        title: `${albumArtist} – ${release.title}`,
        subtitle: `${tracks.length} track${tracks.length === 1 ? "" : "s"} · MusicBrainz release ${release.date?.slice(0, 4) ?? ""}`.trim(),
        origin: "manual",
        catalog: "musicbrainz",
        coverUrl: coverArtUrl("release", release.id, 500),
        tracks
      });
      res.status(201).json({ job });
      return;
    }

    const albumId = String(req.body.albumId || "");
    if (!albumId) {
      throw new ClientError("albumId is required.");
    }
    const catalog = await loadCatalog();
    const plan = await buildSpotifyDownloadPlan(settings, catalog.tracks, albumId, trackIds);
    const tracks = downloadTracksFromSpotifyAlbum(plan.album, plan.selectedTracks);
    const job = await createDownloadJob({
      title: `${plan.album.artist.name} – ${plan.album.name}`,
      subtitle: `${tracks.length} track${tracks.length === 1 ? "" : "s"} · Spotify metadata`,
      origin: "manual",
      catalog: "spotify",
      coverUrl: plan.album.imageUrl,
      tracks
    });
    res.status(201).json({ job });
  }));

  app.delete("/api/downloads/finished", route(async (_req, res) => {
    clearFinishedJobs();
    res.json({ jobs: listDownloadJobs() });
  }));

  app.get("/api/downloads/review", route(async (_req, res) => {
    res.json({ items: listReviewItems() });
  }));

  app.get("/api/downloads/:jobId", route(async (req, res) => {
    const job = getDownloadJob(String(req.params.jobId));
    if (!job) {
      throw new EngineNotFoundError("Download not found.");
    }
    res.json({ job });
  }));

  app.post("/api/downloads/:jobId/cancel", route(async (req, res) => {
    res.json({ job: cancelDownloadJob(String(req.params.jobId)) });
  }));

  app.post("/api/downloads/:jobId/retry", route(async (req, res) => {
    res.json({ job: retryDownloadJob(String(req.params.jobId)) });
  }));

  app.delete("/api/downloads/:jobId", route(async (req, res) => {
    removeDownloadJob(String(req.params.jobId));
    res.json({ ok: true });
  }));

  app.post("/api/downloads/:jobId/items/:itemId/approve", route(async (req, res) => {
    const job = approveReviewItem(String(req.params.jobId), String(req.params.itemId), {
      candidateId: req.body.candidateId ? String(req.body.candidateId) : undefined,
      url: req.body.url ? String(req.body.url) : undefined
    });
    await publishEngineStatus();
    res.json({ job });
  }));

  app.post("/api/downloads/:jobId/items/:itemId/reject", route(async (req, res) => {
    const job = rejectReviewItem(String(req.params.jobId), String(req.params.itemId), {
      keepWanted: req.body.keepWanted !== false
    });
    await publishEngineStatus();
    res.json({ job });
  }));

  app.post("/api/downloads/:jobId/items/:itemId/search", route(async (req, res) => {
    res.json({ job: researchItem(String(req.params.jobId), String(req.params.itemId)) });
  }));

  // Wanted
  app.get("/api/wanted", route(async (_req, res) => {
    res.json({ items: listWanted() });
  }));

  app.post("/api/wanted/run", route(async (_req, res) => {
    const job = await retryDueWanted();
    res.json({ job, items: listWanted() });
  }));

  app.post("/api/wanted/:id/pause", route(async (req, res) => {
    setWantedPaused(String(req.params.id), true);
    res.json({ items: listWanted() });
  }));

  app.post("/api/wanted/:id/resume", route(async (req, res) => {
    setWantedPaused(String(req.params.id), false);
    res.json({ items: listWanted() });
  }));

  app.post("/api/wanted/:id/retry", route(async (req, res) => {
    retryWantedNow(String(req.params.id));
    const job = await retryDueWanted();
    res.json({ job, items: listWanted() });
  }));

  app.delete("/api/wanted/:id", route(async (req, res) => {
    removeWanted(String(req.params.id));
    await publishEngineStatus();
    res.json({ items: listWanted() });
  }));

  // Quarantine
  app.get("/api/quarantine", route(async (_req, res) => {
    res.json({ entries: listQuarantine() });
  }));

  app.delete("/api/quarantine", route(async (req, res) => {
    const candidateId = req.query.candidateId ? String(req.query.candidateId) : undefined;
    const trackKey = req.query.trackKey ? String(req.query.trackKey) : undefined;
    releaseQuarantine(candidateId, trackKey);
    res.json({ entries: listQuarantine() });
  }));

  // Following
  app.get("/api/follows", route(async (_req, res) => {
    const catalog = await loadCatalog();
    res.json({ follows: listFollows(), releases: listReleases(catalog.tracks) });
  }));

  app.post("/api/follows", route(async (req, res) => {
    const artistId = String(req.body.artistId || "");
    const name = String(req.body.name || "").trim();
    if (!artistId || !name) {
      throw new ClientError("artistId and name are required.");
    }
    await followArtist(artistId, {
      name,
      disambiguation: String(req.body.disambiguation || ""),
      autoDownload: req.body.autoDownload === true
    });
    const catalog = await loadCatalog();
    res.status(201).json({ follows: listFollows(), releases: listReleases(catalog.tracks) });
  }));

  app.patch("/api/follows/:artistId", route(async (req, res) => {
    updateFollow(String(req.params.artistId), {
      ...(typeof req.body.autoDownload === "boolean" ? { autoDownload: req.body.autoDownload } : {})
    });
    res.json({ follows: listFollows() });
  }));

  app.delete("/api/follows/:artistId", route(async (req, res) => {
    unfollowArtist(String(req.params.artistId));
    await publishEngineStatus();
    const catalog = await loadCatalog();
    res.json({ follows: listFollows(), releases: listReleases(catalog.tracks) });
  }));

  app.post("/api/follows/check", route(async (_req, res) => {
    await runBackgroundPass(loadSettings, { forceFollows: true });
    const catalog = await loadCatalog();
    res.json({ follows: listFollows(), releases: listReleases(catalog.tracks) });
  }));

  app.post("/api/releases/seen", route(async (req, res) => {
    markReleasesSeen(Array.isArray(req.body.ids) ? req.body.ids.map(String) : undefined);
    await publishEngineStatus();
    res.json({ ok: true });
  }));

  app.post("/api/releases/:releaseGroupId/dismiss", route(async (req, res) => {
    setReleaseStatus(String(req.params.releaseGroupId), "dismissed");
    await publishEngineStatus();
    res.json({ ok: true });
  }));

  app.post("/api/releases/:releaseGroupId/download", route(async (req, res) => {
    if (req.body.rightsConfirmed !== true) {
      throw new ClientError("Confirm you are authorized to download this release first.");
    }
    const releaseGroupId = String(req.params.releaseGroupId);
    const request = await releaseDownloadRequest(releaseGroupId);
    const { release, tracks } = await downloadTracksForRelease(request.releaseId);
    const job = await createDownloadJob({
      title: `${tracks[0]?.albumArtist ?? request.artistName} – ${release.title}`,
      subtitle: "New release by a followed artist",
      origin: "follow",
      catalog: "musicbrainz",
      coverUrl: releaseCoverUrl(releaseGroupId),
      tracks
    });
    setReleaseStatus(releaseGroupId, "queued");
    await publishEngineStatus();
    res.status(201).json({ job });
  }));

  // Upgrades
  app.get("/api/upgrades", route(async (_req, res) => {
    const catalog = await loadCatalog();
    res.json(listUpgradeCandidates(await loadSettings(), catalog.tracks));
  }));

  app.post("/api/upgrades", route(async (req, res) => {
    if (req.body.rightsConfirmed !== true) {
      throw new ClientError("Confirm you are authorized to download replacement copies first.");
    }
    const trackIds = new Set<string>(Array.isArray(req.body.trackIds) ? req.body.trackIds.map(String) : []);
    if (trackIds.size === 0) {
      throw new ClientError("Choose at least one track to upgrade.");
    }
    const catalog = await loadCatalog();
    const selected = catalog.tracks.filter((track) => trackIds.has(track.id));
    const tracks: DownloadTrack[] = selected.map(downloadTrackFromLibraryTrack);
    const replaceTrackIds = Object.fromEntries(tracks.map((track, index) => [track.key, selected[index].id]));
    const job = await createDownloadJob({
      title: `Upgrade ${tracks.length} track${tracks.length === 1 ? "" : "s"}`,
      subtitle: "Replacing low-bitrate copies; originals go to the recycle bin",
      origin: "upgrade",
      catalog: "musicbrainz",
      coverUrl: tracks.find((track) => track.coverUrl)?.coverUrl ?? null,
      tracks,
      replaceTrackIds
    });
    res.status(201).json({ job });
  }));
}

class ClientError extends Error {}

function queuedTrackKeys() {
  const keys = new Set<string>();
  for (const summary of listDownloadJobs()) {
    const job = getDownloadJob(summary.id);
    for (const item of job?.items ?? []) {
      if (item.status !== "completed" && item.status !== "failed" && item.status !== "cancelled" && item.status !== "skipped") {
        keys.add(item.track.key);
      }
    }
  }
  return keys;
}
