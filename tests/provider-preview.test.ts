import assert from "node:assert/strict";
import test from "node:test";
import { chunkItems, mergeProviderPreviews, missingTrackSelection } from "../src/client/App.js";
import type { SpotifyCatalogDownloadPreviewResult, SpotifyTrackSummary } from "../src/shared/types.js";

test("provider preview batches keep every selected album track", () => {
  const trackIds = Array.from({ length: 85 }, (_, index) => `track-${index + 1}`);
  const batches = chunkItems(trackIds, 6);

  assert.equal(batches.length, 15);
  assert.deepEqual(batches.flat(), trackIds);
  assert.ok(batches.every((batch) => batch.length > 0 && batch.length <= 6));
});

test("provider preview batches merge counts, items, and unique warnings", () => {
  const first = preview({ downloadableCount: 4, failedCount: 2, itemCount: 6, warning: "Rate limit" });
  const second = preview({ downloadableCount: 3, failedCount: 3, itemCount: 6, warning: "Rate limit" });
  const merged = mergeProviderPreviews(first, second);

  assert.equal(merged.downloadableCount, 7);
  assert.equal(merged.failedCount, 5);
  assert.equal(merged.items.length, 12);
  assert.deepEqual(merged.warnings, ["Rate limit"]);
});

test("album select all includes missing tracks and excludes local tracks", () => {
  const tracks = [
    { id: "missing-one", present: false },
    { id: "local", present: true },
    { id: "missing-two", present: false }
  ] as SpotifyTrackSummary[];

  assert.deepEqual(missingTrackSelection(tracks), {
    "missing-one": true,
    "missing-two": true
  });
});

function preview({
  downloadableCount,
  failedCount,
  itemCount,
  warning
}: {
  downloadableCount: number;
  failedCount: number;
  itemCount: number;
  warning: string;
}): SpotifyCatalogDownloadPreviewResult {
  return {
    album: { id: "album" } as SpotifyCatalogDownloadPreviewResult["album"],
    downloadableCount,
    failedCount,
    generatedAt: new Date(0).toISOString(),
    items: Array.from({ length: itemCount }, (_, index) => ({
      candidates: [],
      selectedCandidate: null,
      targetRelativePath: `track-${index}.opus`,
      track: { id: `track-${Math.random()}-${index}` } as SpotifyCatalogDownloadPreviewResult["items"][number]["track"]
    })),
    warnings: [warning]
  };
}
