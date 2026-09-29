import type {
  OrganizeChangeField,
  OrganizeCrossCheck,
  OrganizeCrossCheckDifference,
  OrganizePlan,
  SpotifyMetadataMatch,
  TrackFile
} from "../shared/types.js";
import { getDb, parseJson, queryAll, transaction } from "./db.js";
import { looseKey } from "./organize-changes.js";
import { namingYear } from "./organizer.js";
import type { PrivateSettings } from "./settings.js";
import { searchSpotifyTrackMetadata } from "./spotify.js";
import { normalizeForMatch } from "./utils.js";

type Proposal = { albumArtist: string; album: string; title: string; year: string };
type SpotifySearch = (query: string) => Promise<SpotifyMetadataMatch[]>;

/**
 * Checks proposed metadata against Spotify, independently of how it was chosen. The ISRC is tried
 * first because it names the exact recording; a text search is only accepted when the title and
 * artist agree. The result is only an opinion: nothing is changed on disk.
 */
export async function crossCheckTrack(track: TrackFile, search: SpotifySearch): Promise<OrganizeCrossCheck> {
  const proposal = proposalFor(track);
  const checkedAt = new Date().toISOString();
  let method: OrganizeCrossCheck["method"] = "none";
  let matches: SpotifyMetadataMatch[] = [];

  if (track.isrc) {
    matches = await search(`isrc:${track.isrc}`);
    method = "isrc";
  }

  if (matches.length === 0) {
    const artist = track.albumArtist || track.artist;
    const found = await search(`track:"${track.title}" artist:"${artist}"`);
    matches = found.filter((match) => sameText(match.name, track.title) && artistAgrees(match, artist));
    method = "search";
  }

  if (matches.length === 0) {
    return {
      status: "not-found",
      method,
      checkedAt,
      message: track.isrc
        ? "Spotify has no track with this ISRC or this title and artist."
        : "No ISRC in the file, and Spotify has no track with this title and artist.",
      differences: []
    };
  }

  const scored = matches
    .map((match) => ({ match, differences: differencesFrom(proposal, match) }))
    .sort((left, right) => left.differences.length - right.differences.length);
  const best = scored[0];
  const spotify = {
    trackId: best.match.id,
    title: best.match.name,
    albumArtist: best.match.albumArtist,
    album: best.match.album,
    year: best.match.releaseYear,
    trackNumber: best.match.trackNumber,
    url: best.match.spotifyUrl
  };
  const via = method === "isrc" ? "same ISRC" : "title and artist search";

  return best.differences.length === 0
    ? { status: "agrees", method, checkedAt, message: `Spotify agrees (${via}).`, differences: [], spotify }
    : {
        status: "differs",
        method,
        checkedAt,
        message: `Spotify's closest release differs (${via}).`,
        differences: best.differences,
        spotify
      };
}

export async function crossCheckTracks(settings: PrivateSettings, tracks: TrackFile[]) {
  const results: Record<string, OrganizeCrossCheck> = {};
  const errors: string[] = [];
  const search: SpotifySearch = async (query) => (await searchSpotifyTrackMetadata(settings, query)).matches;

  // Sequential on purpose: the Spotify client throttles, and a burst would only queue up behind it.
  let setupProblem: Error | null = null;
  for (const track of tracks) {
    try {
      results[track.id] = await crossCheckTrack(track, search);
    } catch (error) {
      // Missing or rejected credentials fail every track the same way; report that once instead.
      if (/disabled|credentials|HTTP 40[13]/i.test((error as Error).message)) {
        setupProblem = error as Error;
        break;
      }
      errors.push(`${track.relativePath}: ${(error as Error).message}`);
    }
  }

  saveCrossChecks(tracks.filter((track) => results[track.id]), results);
  if (setupProblem && Object.keys(results).length === 0) {
    throw new Error(`Spotify cross-check is unavailable: ${setupProblem.message}`);
  }
  return { results, errors };
}

function saveCrossChecks(tracks: TrackFile[], results: Record<string, OrganizeCrossCheck>) {
  transaction(() => {
    const upsert = getDb().prepare("INSERT OR REPLACE INTO organize_crosschecks (track_id, proposal, data) VALUES (?, ?, ?)");
    for (const track of tracks) {
      upsert.run(track.id, JSON.stringify(proposalFor(track)), JSON.stringify(results[track.id]));
    }
  });
}

/** Adds saved cross-checks to plan items. A check made against a different proposal is ignored. */
export function attachCrossChecks(plan: OrganizePlan, tracks: TrackFile[]): OrganizePlan {
  const saved = new Map(
    queryAll<{ track_id: string; proposal: string; data: string }>("SELECT track_id, proposal, data FROM organize_crosschecks")
      .map((row) => [row.track_id, row] as const)
  );
  if (saved.size === 0) {
    return plan;
  }

  const tracksById = new Map(tracks.map((track) => [track.id, track]));
  return {
    ...plan,
    items: plan.items.map((item) => {
      const row = saved.get(item.id);
      const track = tracksById.get(item.id);
      if (!row || !track || row.proposal !== JSON.stringify(proposalFor(track))) {
        return item;
      }
      const crossCheck = parseJson<OrganizeCrossCheck>(row.data);
      return crossCheck ? { ...item, crossCheck } : item;
    })
  };
}

function proposalFor(track: TrackFile): Proposal {
  const year = namingYear(track);
  return {
    albumArtist: track.albumArtist || track.artist,
    album: track.album,
    title: track.title,
    year: year ? String(year) : ""
  };
}

function differencesFrom(proposal: Proposal, match: SpotifyMetadataMatch): OrganizeCrossCheckDifference[] {
  const differences: OrganizeCrossCheckDifference[] = [];
  const add = (field: OrganizeChangeField, proposed: string, spotify: string) => differences.push({ field, proposed, spotify });

  if (!artistAgrees(match, proposal.albumArtist)) {
    add("albumArtist", proposal.albumArtist, match.albumArtist);
  }
  if (!sameText(match.album, proposal.album)) {
    add("album", proposal.album, match.album);
  }
  if (!sameText(match.name, proposal.title)) {
    add("title", proposal.title, match.name);
  }
  if (proposal.year && match.releaseYear && String(match.releaseYear) !== proposal.year) {
    add("year", proposal.year, String(match.releaseYear));
  }
  return differences;
}

function artistAgrees(match: SpotifyMetadataMatch, artist: string) {
  return [match.albumArtist, ...match.artists].some((name) => sameText(name, artist));
}

/** Equal once case, accents, punctuation and "feat." credits are ignored ("Song - Remix" = "Song (Remix)"). */
function sameText(left: string, right: string) {
  const key = (value: string) => looseKey(normalizeForMatch(value, { removeBracketedText: false }));
  return key(left) === key(right);
}
