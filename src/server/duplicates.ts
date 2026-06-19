import fs from "node:fs/promises";
import path from "node:path";
import type { DuplicateGroup, DuplicateResolveResult, TrackFile } from "../shared/types.js";
import type { PrivateSettings } from "./settings.js";
import { removeTracksFromCatalog } from "./catalog.js";
import { duplicateKeyForTrack } from "./matching.js";
import { toPosixRelative } from "./utils.js";

export function buildDuplicateGroups(tracks: TrackFile[]): DuplicateGroup[] {
  const groups = new Map<string, TrackFile[]>();

  for (const track of tracks) {
    const duplicateKey = duplicateKeyForTrack(track);

    if (!duplicateKey) {
      continue;
    }
    const group = groups.get(duplicateKey) || [];
    group.push(track);
    groups.set(duplicateKey, group);
  }

  return Array.from(groups.entries())
    .filter(([, groupTracks]) => groupTracks.length > 1)
    .map(([key, groupTracks]) => {
      const sorted = [...groupTracks].sort((a, b) => {
        if (b.qualityScore !== a.qualityScore) {
          return b.qualityScore - a.qualityScore;
        }
        return b.size - a.size;
      });

      return {
        key,
        tracks: sorted,
        suggestedKeepId: sorted[0].id,
        reason: duplicateReason(sorted)
      };
    });
}

export async function resolveDuplicates(
  settings: PrivateSettings,
  tracks: TrackFile[],
  keepId: string,
  removeIds: string[]
): Promise<DuplicateResolveResult> {
  const duplicateGroup = buildDuplicateGroups(tracks).find((group) => group.tracks.some((track) => track.id === keepId));

  if (!duplicateGroup) {
    throw new Error("Duplicate selection is no longer valid. Scan and review the group again.");
  }

  const groupTrackIds = new Set(duplicateGroup.tracks.map((track) => track.id));

  if (removeIds.some((id) => !groupTrackIds.has(id))) {
    throw new Error("Duplicate cleanup can only recycle files from the reviewed group.");
  }

  const removeSet = new Set(removeIds.filter((id) => id !== keepId));
  const result: DuplicateResolveResult = {
    keptId: keepId,
    trashed: 0,
    errors: []
  };
  const nowFolder = new Date().toISOString().replace(/[:.]/g, "-");

  for (const track of tracks) {
    if (!removeSet.has(track.id)) {
      continue;
    }

    try {
      const trashRoot = path.resolve(settings.naming.recycleBinPath);
      const target = path.join(trashRoot, nowFolder, track.relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(track.absolutePath, target);
      result.trashed += 1;
    } catch (error) {
      result.errors.push(`${track.relativePath}: ${(error as Error).message}`);
    }
  }

  if (result.trashed > 0) {
    await removeTracksFromCatalog(removeSet);
  }

  return result;
}

function duplicateReason(tracks: TrackFile[]) {
  const extensions = Array.from(new Set(tracks.map((track) => track.extension.toUpperCase().replace(".", ""))));
  const best = tracks[0];
  const pathPreview = toPosixRelative(path.dirname(best.absolutePath), best.absolutePath);
  return `${extensions.join(" / ")} same organized album, disc/track, title/version, and duration; suggested keep is ${best.extension.toUpperCase().replace(".", "")} (${pathPreview})`;
}

