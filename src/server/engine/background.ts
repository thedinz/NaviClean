import type { EngineStatus } from "../../shared/types.js";
import { publish } from "../events.js";
import { engineSettings, type PrivateSettings } from "../settings.js";
import { downloadTracksForRelease } from "../catalog-browse.js";
import { checkFollowedArtists, releaseCoverUrl, unseenReleaseCount } from "./follows.js";
import { activeJobCount, createDownloadJob, listReviewItems } from "./jobs.js";
import { downloadSources } from "./sources.js";
import { dueWanted, markWantedSearching, resetInterruptedWanted, wantedCount } from "./wanted.js";

/**
 * Background loops: the Wanted watcher re-searches tracks that could not be acquired, and
 * the follow checker looks for new releases by followed artists.
 */

const tickMs = 5 * 60 * 1000;
const wantedBatchSize = 10;
let timer: NodeJS.Timeout | null = null;
let lastWantedRunAt = 0;
let running = false;
let sourceStatusCache: { at: number; value: EngineStatus["sources"] } | null = null;

export function startBackgroundWork(loadSettings: () => Promise<PrivateSettings>) {
  resetInterruptedWanted();
  if (timer) {
    return;
  }
  const tick = () => {
    void runBackgroundPass(loadSettings).catch((error) => console.error("Background engine pass failed:", error));
  };
  timer = setInterval(tick, tickMs);
  timer.unref();
  // Give the server a moment to come up before the first pass.
  setTimeout(tick, 30_000).unref();
}

export async function runBackgroundPass(loadSettings: () => Promise<PrivateSettings>, options: { forceFollows?: boolean } = {}) {
  if (running) {
    return;
  }
  running = true;

  try {
    const settings = await loadSettings();
    const engine = engineSettings(settings);

    if (engine.wantedEnabled && Date.now() - lastWantedRunAt >= engine.wantedIntervalMinutes * 60 * 1000) {
      lastWantedRunAt = Date.now();
      await retryDueWanted();
    }

    const { autoDownloads, found } = await checkFollowedArtists(settings, { force: options.forceFollows });
    for (const request of autoDownloads) {
      const { release, tracks } = await downloadTracksForRelease(request.releaseId);
      await createDownloadJob({
        title: `${request.artistName} – ${release.title}`,
        subtitle: "New release by a followed artist",
        origin: "follow",
        catalog: "musicbrainz",
        coverUrl: releaseCoverUrl(request.releaseGroupId),
        tracks
      });
    }
    if (found > 0 || autoDownloads.length > 0) {
      await publishEngineStatus();
    }
  } finally {
    running = false;
  }
}

export async function retryDueWanted() {
  const due = dueWanted(wantedBatchSize);
  if (due.length === 0) {
    return null;
  }
  markWantedSearching(due.map((item) => item.id));
  const job = await createDownloadJob({
    title: `Wanted: ${due.length} track${due.length === 1 ? "" : "s"}`,
    subtitle: "Background re-search of tracks that could not be found earlier",
    origin: "wanted",
    catalog: due[0].track.catalog,
    coverUrl: due[0].track.coverUrl,
    tracks: due.map((item) => item.track)
  });
  await publishEngineStatus();
  return job;
}

export async function engineStatus(settings: PrivateSettings): Promise<EngineStatus> {
  const engine = engineSettings(settings);
  if (!sourceStatusCache || Date.now() - sourceStatusCache.at > 10 * 60 * 1000) {
    const value = await Promise.all(
      downloadSources.map(async (source) => {
        const availability = await source.checkAvailability();
        return {
          id: source.id,
          label: source.label,
          available: availability.available,
          enabled: !engine.disabledSources.includes(source.id),
          message: availability.message
        };
      })
    );
    sourceStatusCache = { at: Date.now(), value };
  }

  return {
    activeJobs: activeJobCount(),
    reviewCount: listReviewItems().length,
    wantedCount: wantedCount(),
    newReleaseCount: unseenReleaseCount(),
    sources: sourceStatusCache.value.map((source) => ({ ...source, enabled: !engine.disabledSources.includes(source.id) }))
  };
}

let statusSettingsLoader: (() => Promise<PrivateSettings>) | null = null;

export function setEngineStatusSettingsLoader(loader: () => Promise<PrivateSettings>) {
  statusSettingsLoader = loader;
}

export async function publishEngineStatus() {
  if (!statusSettingsLoader) {
    return;
  }
  publish({ type: "engine", status: await engineStatus(await statusSettingsLoader()) });
}
