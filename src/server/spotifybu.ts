export type SpotifyBuTagContainer = {
  common?: Record<string, unknown>;
  native?: Record<string, Array<{ id: string; value: unknown }>>;
};

export type SpotifyBuMetadataSource = {
  albumId?: string | null;
  albumSpotifyUrl?: string | null;
  trackId: string;
  trackSpotifyUrl?: string | null;
};

const spotifyBuTrackIdentityKeys = new Set(["spotifybu:track_id", "spotifybu:track_uri"]);
const spotifyBuTrackIdentityLookupKeys = new Set(
  Array.from(spotifyBuTrackIdentityKeys, normalizeTagLookupKey)
);

export function hasSpotifyBuIdentityTags(tags: SpotifyBuTagContainer | null | undefined) {
  return hasSpotifyBuIdentityCommonTag(tags?.common) || hasSpotifyBuIdentityNativeTag(tags?.native);
}

export function spotifyBuMetadataTagsForSpotifyTrack(source: SpotifyBuMetadataSource) {
  const tags = [
    {
      key: "spotifybu:track_id",
      value: source.trackId
    },
    {
      key: "spotifybu:track_uri",
      value: `spotify:track:${source.trackId}`
    }
  ];

  if (source.trackSpotifyUrl) {
    tags.push({
      key: "spotifybu:track_url",
      value: source.trackSpotifyUrl
    });
  }

  if (source.albumId) {
    tags.push(
      {
        key: "spotifybu:album_id",
        value: source.albumId
      },
      {
        key: "spotifybu:album_uri",
        value: `spotify:album:${source.albumId}`
      }
    );
  }

  if (source.albumSpotifyUrl) {
    tags.push({
      key: "spotifybu:album_url",
      value: source.albumSpotifyUrl
    });
  }

  return tags;
}

function hasSpotifyBuIdentityCommonTag(common: SpotifyBuTagContainer["common"]) {
  if (!common) {
    return false;
  }

  return Object.entries(common).some(([key, value]) =>
    spotifyBuTagKeyIsTrackIdentity(key) && tagValueIsPresent(value)
  );
}

function hasSpotifyBuIdentityNativeTag(native: SpotifyBuTagContainer["native"] | undefined) {
  if (!native) {
    return false;
  }

  return Object.values(native).some((tags) =>
    tags.some((tag) => spotifyBuTagKeyIsTrackIdentity(tag.id) && tagValueIsPresent(tag.value))
  );
}

function spotifyBuTagKeyIsTrackIdentity(key: string) {
  const lowerKey = key.trim().toLowerCase();

  if (spotifyBuTrackIdentityKeys.has(lowerKey)) {
    return true;
  }

  const parts = lowerKey.split(":").filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const suffix = parts.slice(index).join(":");

    if (
      spotifyBuTrackIdentityKeys.has(suffix) ||
      spotifyBuTrackIdentityLookupKeys.has(normalizeTagLookupKey(suffix))
    ) {
      return true;
    }
  }

  return spotifyBuTrackIdentityLookupKeys.has(normalizeTagLookupKey(lowerKey));
}

function normalizeTagLookupKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
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
