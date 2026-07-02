export type SpotifyBuTagContainer = {
  common?: Record<string, unknown>;
  native?: Record<string, Array<{ id: string; value: unknown }>>;
};

export type SpotifyBuMetadataSource = {
  albumId?: string | null;
  isrc?: string | null;
  trackId: string;
};

const spotifyBuIdentityVersion = "1";
const spotifyBuIdentityKeys = [
  "spotifybu:track_id",
  "spotifybu:track_uri",
  "spotifybu:album_id",
  "spotifybu:isrc",
  "spotifybu:identity_version"
];
const spotifyBuIdentityKeyAliases = new Set(
  spotifyBuIdentityKeys.flatMap((key) => spotifyBuAliasesForKey(key)).map(normalizeSpotifyBuTagKey)
);

export function hasSpotifyBuIdentityTags(tags: SpotifyBuTagContainer | null | undefined) {
  return hasSpotifyBuIdentityCommonTag(tags?.common) || hasSpotifyBuIdentityNativeTag(tags?.native);
}

export function spotifyBuMetadataTagsForSpotifyTrack(source: SpotifyBuMetadataSource) {
  return [
    {
      key: "spotifybu:track_id",
      value: source.trackId
    },
    {
      key: "spotifybu:track_uri",
      value: `spotify:track:${source.trackId}`
    },
    {
      key: "spotifybu:album_id",
      value: source.albumId ?? ""
    },
    {
      key: "spotifybu:isrc",
      value: normalizeSpotifyBuIsrc(source.isrc)
    },
    {
      key: "spotifybu:identity_version",
      value: spotifyBuIdentityVersion
    }
  ];
}

function hasSpotifyBuIdentityCommonTag(common: SpotifyBuTagContainer["common"]) {
  if (!common) {
    return false;
  }

  return Object.entries(common).some(([key, value]) =>
    spotifyBuTagKeyIsIdentity(key) && tagValueIsPresent(value)
  );
}

function hasSpotifyBuIdentityNativeTag(native: SpotifyBuTagContainer["native"] | undefined) {
  if (!native) {
    return false;
  }

  return Object.values(native).some((tags) =>
    tags.some((tag) => spotifyBuTagKeyIsIdentity(tag.id) && tagValueIsPresent(tag.value))
  );
}

function spotifyBuTagKeyIsIdentity(key: string) {
  const normalizedKey = normalizeSpotifyBuTagKey(key);

  if (spotifyBuIdentityKeyAliases.has(normalizedKey)) {
    return true;
  }

  const parts = key.trim().toLowerCase().split(":").filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const suffix = parts.slice(index).join(":");

    if (spotifyBuIdentityKeyAliases.has(normalizeSpotifyBuTagKey(suffix))) {
      return true;
    }
  }

  return false;
}

function spotifyBuAliasesForKey(key: string) {
  const name = key.replace(/^spotifybu:/, "");
  return [
    key,
    `spotifybu_${name}`,
    `----:com.apple.itunes:spotifybu:${name}`
  ];
}

function normalizeSpotifyBuTagKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeSpotifyBuIsrc(value: string | null | undefined) {
  return typeof value === "string" ? value.replace(/[^a-z0-9]/gi, "").toUpperCase() : "";
}

function tagValueIsPresent(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (value instanceof Uint8Array) {
    return value.length > 0;
  }

  if (Array.isArray(value)) {
    return value.some(tagValueIsPresent);
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return ["text", "value", "identifier", "url"].some((key) => tagValueIsPresent(record[key]));
  }

  return false;
}
