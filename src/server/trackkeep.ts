export type TrackKeepTagContainer = {
  common?: Record<string, unknown>;
  native?: Record<string, Array<{ id: string; value: unknown }>>;
};

export type TrackKeepMetadataSource = {
  albumId?: string | null;
  isrc?: string | null;
  trackId: string;
};

export type TrackKeepManagedBy = "trackkeep";

const trackKeepIdentityVersion = "1";
const identityNamespaces = ["trackkeep", "spotifybu"] as const;
const identityNames = ["track_id", "track_uri", "album_id", "isrc", "identity_version"] as const;
const identityCommentPrefixes = ["TrackKeep identity ", "SpotifyBU identity "] as const;

const identityKeyAliases = new Set(
  identityNamespaces.flatMap((namespace) =>
    identityNames.flatMap((name) => aliasesForIdentityKey(namespace, name))
  ).map(normalizeTagKey)
);

/**
 * Detects both current TrackKeep identity metadata and intentional legacy
 * SpotifyBU aliases so files remain protected across the product rename.
 */
export function hasTrackKeepIdentityTags(tags: TrackKeepTagContainer | null | undefined) {
  return hasTrackKeepIdentityCommonTag(tags?.common) || hasTrackKeepIdentityNativeTag(tags?.native);
}

/**
 * NaviClean dual-writes current TrackKeep tags and legacy SpotifyBU tags so
 * both current and older companion releases recognize provider downloads.
 */
export function trackKeepMetadataTagsForSpotifyTrack(source: TrackKeepMetadataSource) {
  const values = {
    track_id: source.trackId,
    track_uri: `spotify:track:${source.trackId}`,
    album_id: source.albumId ?? "",
    isrc: normalizeIsrc(source.isrc),
    identity_version: trackKeepIdentityVersion
  } satisfies Record<(typeof identityNames)[number], string>;

  return identityNamespaces.flatMap((namespace) =>
    identityNames.map((name) => ({
      key: `${namespace}:${name}`,
      value: values[name]
    }))
  );
}

export function normalizeTrackKeepManagedBy(value: unknown): TrackKeepManagedBy | undefined {
  // "spotifybu" is accepted only as a persisted/external compatibility alias.
  return value === "trackkeep" || value === "spotifybu" ? "trackkeep" : undefined;
}

export function isTrackKeepManaged(value: unknown) {
  return normalizeTrackKeepManagedBy(value) === "trackkeep";
}

function hasTrackKeepIdentityCommonTag(common: TrackKeepTagContainer["common"]) {
  if (!common) {
    return false;
  }

  return Object.entries(common).some(([key, value]) =>
    (identityTagKeyIsRecognized(key) && tagValueIsPresent(value)) ||
    (tagKeyIsComment(key) && commentValueHasIdentity(value))
  );
}

function hasTrackKeepIdentityNativeTag(native: TrackKeepTagContainer["native"] | undefined) {
  if (!native) {
    return false;
  }

  return Object.values(native).some((tags) =>
    tags.some((tag) =>
      (identityTagKeyIsRecognized(tag.id) && tagValueIsPresent(tag.value)) ||
      (tagKeyIsComment(tag.id) && commentValueHasIdentity(tag.value))
    )
  );
}

function identityTagKeyIsRecognized(key: string) {
  const normalizedKey = normalizeTagKey(key);

  if (identityKeyAliases.has(normalizedKey)) {
    return true;
  }

  const parts = key.trim().toLowerCase().split(":").filter(Boolean);
  return parts.some((_, index) => identityKeyAliases.has(normalizeTagKey(parts.slice(index).join(":"))));
}

function aliasesForIdentityKey(namespace: (typeof identityNamespaces)[number], name: (typeof identityNames)[number]) {
  const key = `${namespace}:${name}`;
  return [
    key,
    `${namespace}_${name}`,
    `----:com.apple.itunes:${key}`,
    `TXXX:${key}`
  ];
}

function normalizeTagKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tagKeyIsComment(key: string) {
  const normalizedKey = normalizeTagKey(key);
  return normalizedKey === "comment" || normalizedKey === "comments" || normalizedKey === "comm" || normalizedKey === "cmt";
}

function commentValueHasIdentity(value: unknown): boolean {
  if (typeof value === "string") {
    return identityCommentJsonHasMarker(value);
  }

  if (value instanceof Uint8Array) {
    return identityCommentJsonHasMarker(new TextDecoder().decode(value));
  }

  if (Array.isArray(value)) {
    return value.some(commentValueHasIdentity);
  }

  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(commentValueHasIdentity);
  }

  return false;
}

function identityCommentJsonHasMarker(value: string) {
  const trimmedValue = value.trim();
  const prefix = identityCommentPrefixes.find((candidate) =>
    trimmedValue.toLowerCase().startsWith(candidate.toLowerCase())
  );

  if (!prefix) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmedValue.slice(prefix.length)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }

    return Object.entries(parsed).some(([key, entryValue]) =>
      identityTagKeyIsRecognized(key) && tagValueIsPresent(entryValue)
    );
  } catch {
    return false;
  }
}

function normalizeIsrc(value: string | null | undefined) {
  return typeof value === "string" ? value.replace(/[^a-z0-9]/gi, "").toUpperCase() : "";
}

function tagValueIsPresent(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value === "boolean") {
    return value;
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
