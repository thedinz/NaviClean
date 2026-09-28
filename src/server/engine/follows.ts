import type { ArtistRelease, FollowedArtist, TrackFile } from "../../shared/types.js";
import { execute, parseJson, queryAll, queryOne, transaction, getDb } from "../db.js";
import {
  browseMusicBrainzReleaseGroups,
  browseMusicBrainzReleases,
  coverArtUrl,
  getMusicBrainzRelease,
  preferredRelease,
  type MbReleaseGroup
} from "../musicbrainz.js";
import { engineSettings, type PrivateSettings } from "../settings.js";
import { LibraryPresence } from "./presence.js";

/**
 * Followed artists and the release groups seen for them. Following records the current
 * discography as a baseline, so only releases that appear afterwards count as new.
 */

type FollowData = { name: string; disambiguation: string; autoDownload: boolean };
type ReleaseData = {
  artistName: string;
  title: string;
  primaryType: string;
  secondaryTypes: string[];
  firstReleaseDate: string;
};
type ReleaseRow = { id: string; artist_id: string; data: string; first_seen_at: string; seen: number; status: ArtistRelease["status"] };

export type ReleaseDownloadRequest = {
  releaseGroupId: string;
  releaseId: string;
  title: string;
  artistName: string;
};

export function isFollowed(artistId: string) {
  return Boolean(queryOne("SELECT 1 FROM follows WHERE artist_id = ?", artistId));
}

export async function followArtist(artistId: string, details: FollowData) {
  const groups = await browseMusicBrainzReleaseGroups(artistId, { fresh: true });
  const now = new Date().toISOString();

  transaction(() => {
    const db = getDb();
    db.prepare(
      `INSERT INTO follows (artist_id, data, created_at, last_checked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(artist_id) DO UPDATE SET data = excluded.data`
    ).run(artistId, JSON.stringify(details), now, now);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO releases (id, artist_id, data, first_seen_at, seen, status) VALUES (?, ?, ?, ?, 1, 'existing')"
    );
    for (const group of groups) {
      insert.run(group.id, artistId, JSON.stringify(releaseData(group, details.name)), now);
    }
  });
}

export function updateFollow(artistId: string, changes: Partial<FollowData>) {
  const row = queryOne<{ data: string }>("SELECT data FROM follows WHERE artist_id = ?", artistId);
  const current = row ? parseJson<FollowData>(row.data) : null;
  if (!current) {
    throw new Error("That artist is not followed.");
  }
  execute("UPDATE follows SET data = ? WHERE artist_id = ?", JSON.stringify({ ...current, ...changes }), artistId);
}

export function unfollowArtist(artistId: string) {
  transaction(() => {
    execute("DELETE FROM follows WHERE artist_id = ?", artistId);
    execute("DELETE FROM releases WHERE artist_id = ?", artistId);
  });
}

export function listFollows(): FollowedArtist[] {
  const counts = new Map(
    queryAll<{ artist_id: string; count: number }>(
      "SELECT artist_id, COUNT(*) AS count FROM releases WHERE status = 'new' GROUP BY artist_id"
    ).map((row) => [row.artist_id, row.count])
  );
  return queryAll<{ artist_id: string; data: string; created_at: string; last_checked_at: string | null }>(
    "SELECT artist_id, data, created_at, last_checked_at FROM follows"
  )
    .map((row) => {
      const data = parseJson<FollowData>(row.data);
      return data
        ? {
            artistId: row.artist_id,
            name: data.name,
            disambiguation: data.disambiguation,
            autoDownload: data.autoDownload,
            createdAt: row.created_at,
            lastCheckedAt: row.last_checked_at,
            newReleaseCount: counts.get(row.artist_id) ?? 0
          }
        : null;
    })
    .filter((follow): follow is FollowedArtist => Boolean(follow))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

export function listReleases(libraryTracks: TrackFile[], options: { includeExisting?: boolean } = {}): ArtistRelease[] {
  const presence = new LibraryPresence(libraryTracks);
  const rows = options.includeExisting
    ? queryAll<ReleaseRow>("SELECT * FROM releases ORDER BY first_seen_at DESC")
    : queryAll<ReleaseRow>("SELECT * FROM releases WHERE status != 'existing' ORDER BY first_seen_at DESC LIMIT 300");

  return rows
    .map((row) => {
      const data = parseJson<ReleaseData>(row.data);
      return data
        ? {
            id: row.id,
            artistId: row.artist_id,
            artistName: data.artistName,
            title: data.title,
            primaryType: data.primaryType,
            secondaryTypes: data.secondaryTypes,
            firstReleaseDate: data.firstReleaseDate,
            status: row.status,
            seen: row.seen === 1,
            firstSeenAt: row.first_seen_at,
            inLibrary: presence.albumTrackCount(row.id, data.artistName, data.title) > 0
          }
        : null;
    })
    .filter((release): release is ArtistRelease => Boolean(release))
    .sort((left, right) => (right.firstReleaseDate || "").localeCompare(left.firstReleaseDate || ""));
}

export function unseenReleaseCount() {
  return queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM releases WHERE seen = 0")?.count ?? 0;
}

export function markReleasesSeen(ids?: string[]) {
  if (!ids) {
    execute("UPDATE releases SET seen = 1 WHERE seen = 0");
    return;
  }
  transaction(() => {
    for (const id of ids) {
      execute("UPDATE releases SET seen = 1 WHERE id = ?", id);
    }
  });
}

export function setReleaseStatus(id: string, status: ArtistRelease["status"]) {
  execute("UPDATE releases SET status = ?, seen = 1 WHERE id = ?", status, id);
}

/** Picks the edition to download for a release group. */
export async function releaseDownloadRequest(releaseGroupId: string): Promise<ReleaseDownloadRequest> {
  const row = queryOne<ReleaseRow>("SELECT * FROM releases WHERE id = ?", releaseGroupId);
  const data = row ? parseJson<ReleaseData>(row.data) : null;
  const releases = await browseMusicBrainzReleases(releaseGroupId);
  const release = preferredRelease(releases);
  if (!release) {
    throw new Error("MusicBrainz lists no editions for this release yet. Try again after it is published.");
  }
  return {
    releaseGroupId,
    releaseId: release.id,
    title: data?.title ?? release.title,
    artistName: data?.artistName ?? ""
  };
}

/**
 * Checks followed artists whose last check is older than the configured interval.
 * Returns releases that should be downloaded automatically.
 */
export async function checkFollowedArtists(settings: PrivateSettings, options: { force?: boolean } = {}) {
  const engine = engineSettings(settings);
  const dueBefore = Date.now() - engine.followCheckHours * 60 * 60 * 1000;
  const today = new Date().toISOString().slice(0, 10);
  const follows = queryAll<{ artist_id: string; data: string; last_checked_at: string | null }>(
    "SELECT artist_id, data, last_checked_at FROM follows"
  );
  const autoDownloads: ReleaseDownloadRequest[] = [];
  let found = 0;

  for (const follow of follows) {
    if (!options.force && follow.last_checked_at && Date.parse(follow.last_checked_at) > dueBefore) {
      continue;
    }
    const data = parseJson<FollowData>(follow.data);
    if (!data) {
      continue;
    }

    let groups: MbReleaseGroup[];
    try {
      groups = await browseMusicBrainzReleaseGroups(follow.artist_id, { fresh: true });
    } catch {
      continue;
    }

    const now = new Date().toISOString();
    const known = new Set(
      queryAll<{ id: string }>("SELECT id FROM releases WHERE artist_id = ?", follow.artist_id).map((row) => row.id)
    );
    for (const group of groups) {
      if (known.has(group.id) || !isNotableRelease(group)) {
        continue;
      }
      execute(
        "INSERT OR IGNORE INTO releases (id, artist_id, data, first_seen_at, seen, status) VALUES (?, ?, ?, ?, 0, 'new')",
        group.id,
        follow.artist_id,
        JSON.stringify(releaseData(group, data.name)),
        now
      );
      found += 1;
      const released = !group["first-release-date"] || group["first-release-date"] <= today;
      if ((data.autoDownload || engine.autoDownloadFollowedReleases) && released) {
        try {
          const request = await releaseDownloadRequest(group.id);
          autoDownloads.push({ ...request, artistName: data.name });
          setReleaseStatus(group.id, "queued");
        } catch {
          // Leave it as a new release; the user can download it once an edition exists.
        }
      }
    }
    execute("UPDATE follows SET last_checked_at = ? WHERE artist_id = ?", now, follow.artist_id);
  }

  return { found, autoDownloads };
}

export async function loadReleaseForDownload(releaseId: string) {
  return getMusicBrainzRelease(releaseId);
}

export function releaseCoverUrl(releaseGroupId: string) {
  return coverArtUrl("release-group", releaseGroupId, 500);
}

/** Studio albums, EPs, and singles. Compilations, live sets, remixes, and bootlegs are not announced. */
function isNotableRelease(group: MbReleaseGroup) {
  const primary = group["primary-type"];
  return (primary === "Album" || primary === "EP" || primary === "Single") && (group["secondary-types"] ?? []).length === 0;
}

function releaseData(group: MbReleaseGroup, artistName: string): ReleaseData {
  return {
    artistName,
    title: group.title,
    primaryType: group["primary-type"] ?? "Other",
    secondaryTypes: group["secondary-types"] ?? [],
    firstReleaseDate: group["first-release-date"] ?? ""
  };
}
