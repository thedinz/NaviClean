import type {
  SpotifyAlbumDetail,
  SpotifyCatalogDownloadJob,
  SpotifyCatalogDownloadPreviewResult,
  SpotifyTrackSummary
} from "../../shared/types";

export function chunkItems<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function missingTrackSelection(tracks: SpotifyTrackSummary[]) {
  return Object.fromEntries(tracks.filter((track) => !track.present).map((track) => [track.id, true]));
}

export function mergeProviderPreviews(
  current: SpotifyCatalogDownloadPreviewResult | null,
  next: SpotifyCatalogDownloadPreviewResult
): SpotifyCatalogDownloadPreviewResult {
  if (!current) {
    return next;
  }

  return {
    album: current.album,
    downloadableCount: current.downloadableCount + next.downloadableCount,
    failedCount: current.failedCount + next.failedCount,
    generatedAt: next.generatedAt,
    items: [...current.items, ...next.items],
    warnings: Array.from(new Set([...current.warnings, ...next.warnings]))
  };
}

export function isCatalogDownloadJobActive(job: SpotifyCatalogDownloadJob | null) {
  return job?.status === "queued" || job?.status === "running";
}

export function isCatalogDownloadJobTerminal(job: SpotifyCatalogDownloadJob) {
  return job.status === "completed" || job.status === "failed";
}

export function albumWithCompletedDownloads(
  album: SpotifyAlbumDetail,
  job: SpotifyCatalogDownloadJob
): SpotifyAlbumDetail {
  const completedTrackIds = new Set(
    job.items.filter((item) => item.status === "completed").map((item) => item.track.id)
  );
  const tracks = album.tracks.map((track) =>
    completedTrackIds.has(track.id) ? { ...track, present: true } : track
  );

  return {
    ...album,
    localTrackCount: tracks.filter((track) => track.present).length,
    tracks
  };
}
