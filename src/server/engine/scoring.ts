import type { CatalogProviderCandidateScore, DownloadTrack } from "../../shared/types.js";
import { normalizeForMatch } from "../utils.js";

export type CandidateFacts = {
  title: string;
  artists: string[];
  channel?: string;
  album?: string;
  durationMs?: number;
  viewCount?: number;
  /** Search rank from the provider, 0-based. */
  rank: number;
};

export type ScoredCandidate = {
  score: CatalogProviderCandidateScore;
  flags: string[];
};

const titleNoiseTokens = new Set(["audio", "hd", "hq", "lyric", "lyrics", "official", "video", "visualizer", "4k", "mv", "m v"]);
const albumEditionTokens = new Set(["anniversary", "deluxe", "edition", "expanded", "live", "remaster", "remastered"]);

/**
 * Words that mark a different performance or edit of a song. A candidate carrying one of
 * these, when the requested track does not, is almost never the release the user wants.
 */
const versionMarkers: Array<{ flag: string; pattern: RegExp }> = [
  { flag: "live", pattern: /\b(live|concert|unplugged|in session|live at|live from|letterman|fallon|kimmel|kexp|tiny desk|bbc session)\b/ },
  { flag: "remix", pattern: /\b(remix|rmx|bootleg mix|club mix|dub mix|vip mix|flip)\b/ },
  { flag: "acoustic", pattern: /\bacoustic\b/ },
  { flag: "instrumental", pattern: /\b(instrumental|karaoke|backing track|minus one|off vocal)\b/ },
  { flag: "cover", pattern: /\b(cover|covered by|tribute|in the style of)\b/ },
  { flag: "speed", pattern: /\b(sped up|speed up|slowed|reverb|nightcore|daycore|8d|bass boosted|chipmunk)\b/ },
  { flag: "edit", pattern: /\b(radio edit|extended mix|extended version|clean version|mashup|medley)\b/ },
  { flag: "demo", pattern: /\b(demo|outtake|outtakes|rehearsal|alternate take|early version)\b/ },
  { flag: "a-cappella", pattern: /\b(a cappella|acapella|vocals only|isolated vocals)\b/ },
  { flag: "reaction", pattern: /\b(reaction|reacts|review|lesson|tutorial|how to play|guitar cover|drum cover|piano cover)\b/ },
  { flag: "altered", pattern: /\b(432 ?hz|528 ?hz|8 ?bit|16 ?bit|chiptune|emulation|music box|lullaby|orchestral version|symphonic version)\b/ }
];

/** 0-100 score for how likely a provider result is the exact requested recording. */
export function scoreCandidate(track: DownloadTrack, facts: CandidateFacts): ScoredCandidate {
  const flags: string[] = [];
  const channel = facts.channel ?? facts.artists[0] ?? "";
  const topicChannel = /\s-\sTopic$/i.test(channel);
  const artistTexts = [...facts.artists, channel.replace(/\s-\sTopic$/i, "")].filter(Boolean);

  const titleScore = titleSimilarity(track.title, facts.title, track.album);
  const requestedArtists = track.artists.length ? track.artists : [track.albumArtist];
  const artistScore = artistSimilarity(requestedArtists, artistTexts.join(" "), facts.title);
  // Credited/uploading artist, ignoring any artist name that only appears in the title text.
  const creditedArtistScore = Math.max(0, ...requestedArtists.map((artist) => textSimilarity(artist, artistTexts.join(" "))));
  const durationDeltaMs = typeof facts.durationMs === "number" && track.durationMs > 0
    ? Math.abs(facts.durationMs - track.durationMs)
    : undefined;
  const durationScore = typeof durationDeltaMs === "number"
    ? Math.max(0, 100 - Math.round(durationDeltaMs / 1000) * 4)
    : 50;
  const albumScore = track.album ? albumSimilarity(track.album, facts.album, facts.title) : 0;

  let overall = titleScore * 0.46 + artistScore * 0.32 + durationScore * 0.2 + albumScore * 0.06;

  if (topicChannel) {
    // YouTube's auto-generated "Artist - Topic" uploads are the label's release audio.
    overall += 8;
    flags.push("topic-channel");
  } else if (/vevo$/i.test(channel)) {
    overall += 3;
    flags.push("vevo");
  } else if (creditedArtistScore >= 80) {
    overall += 3;
    flags.push("artist-channel");
  } else if (creditedArtistScore < 50) {
    // The artist is only named in the title: a re-upload or someone else's recording.
    overall -= 8;
    flags.push("third-party");
  }

  const candidateText = normalizeForMatch(`${facts.title} ${channel}`, { removeBracketedText: false });
  const requestedText = normalizeForMatch(`${track.title} ${track.album} ${track.albumType}`, { removeBracketedText: false });
  if (/\b(official music video|music video|official video)\b/.test(candidateText) && !topicChannel) {
    // Music videos often add intros, skits, or outros that break duration and fingerprint checks.
    overall -= 4;
    flags.push("music-video");
  } else if (/\bofficial audio\b/.test(candidateText)) {
    overall += 3;
    flags.push("official-audio");
  }

  for (const marker of versionMarkers) {
    if (marker.pattern.test(candidateText) && !marker.pattern.test(requestedText)) {
      overall *= 0.35;
      flags.push(`version:${marker.flag}`);
      break;
    }
  }

  if (typeof durationDeltaMs === "number" && durationDeltaMs > 30_000) {
    overall = Math.min(overall, 45);
    flags.push("duration-far");
  }

  if (typeof facts.viewCount === "number" && facts.viewCount > 0) {
    overall += Math.min(3, Math.log10(facts.viewCount) / 3);
  }

  overall -= Math.min(6, facts.rank);

  const score: CatalogProviderCandidateScore = {
    albumScore,
    artistScore,
    overall: Math.max(0, Math.min(100, Math.round(overall))),
    titleScore
  };
  if (typeof durationDeltaMs === "number") {
    score.durationDeltaMs = durationDeltaMs;
  }

  return { score, flags };
}

export function titleSimilarity(trackTitle: string, candidateTitle: string, trackAlbum?: string) {
  const target = tokenSet(stripFeaturing(trackTitle));
  return Math.max(
    directionalSimilarity(target, tokenSet(candidateTitle, titleNoiseTokens)),
    ...titleSegments(candidateTitle).map((segment) => directionalSimilarity(target, tokenSet(segment, titleNoiseTokens))),
    trackAlbum ? directionalSimilarity(tokenSet(`${trackTitle} ${trackAlbum}`), tokenSet(candidateTitle, titleNoiseTokens)) : 0
  );
}

function artistSimilarity(trackArtists: string[], candidateArtistText: string, candidateTitle: string) {
  const scores = trackArtists.map((artist) =>
    Math.max(textSimilarity(artist, candidateArtistText), metadataSegmentSimilarity(artist, candidateTitle))
  );
  if (!scores.length) {
    return 0;
  }
  const best = Math.max(...scores);
  const average = scores.reduce((total, value) => total + value, 0) / scores.length;
  return Math.round(best * 0.6 + average * 0.4);
}

function albumSimilarity(trackAlbum: string, candidateAlbum: string | undefined, candidateTitle: string) {
  const trackTokens = tokenSet(trackAlbum, albumEditionTokens);
  const values = [candidateAlbum, ...titleSegments(candidateTitle)].filter((value): value is string => Boolean(value));
  return Math.max(...values.map((value) => directionalSimilarity(trackTokens, tokenSet(value, albumEditionTokens))), 0);
}

function metadataSegmentSimilarity(target: string, candidateValue: string) {
  const targetTokens = tokenSet(target);
  return Math.max(
    ...titleSegments(candidateValue).map((segment) => directionalSimilarity(targetTokens, tokenSet(segment, titleNoiseTokens))),
    0
  );
}

export function textSimilarity(left: string, right: string) {
  return directionalSimilarity(tokenSet(left), tokenSet(right));
}

function directionalSimilarity(targetTokens: Set<string>, candidateTokens: Set<string>) {
  if (!targetTokens.size || !candidateTokens.size) {
    return 0;
  }
  let shared = 0;
  for (const token of targetTokens) {
    if (candidateTokens.has(token)) {
      shared += 1;
    }
  }
  const coverage = shared / targetTokens.size;
  const jaccard = shared / new Set([...targetTokens, ...candidateTokens]).size;
  return Math.round((coverage * 0.8 + jaccard * 0.2) * 100);
}

function tokenSet(value: string, ignored = new Set<string>()) {
  return new Set(
    normalizeForMatch(value, { removeBracketedText: false })
      .split(" ")
      .filter((token) => token && !ignored.has(token))
  );
}

function titleSegments(value: string) {
  return value
    .split(/\s+[-:|–—]\s+|\(|\)|\[|]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function stripFeaturing(value: string) {
  return value.replace(/\s*[([]?\b(feat|ft|featuring)\.?\s[^)\]]*[)\]]?/gi, " ").trim() || value;
}
