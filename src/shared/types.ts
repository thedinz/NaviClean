export type AuthInfo = {
  advancedDiagnosticsEnabled: boolean;
  authEnabled: boolean;
  authenticated: boolean;
  /** True while the account still uses the shipped default password. */
  mustChangePassword: boolean;
  username: string | null;
};

export type QualityCodecFamily = "opus" | "vorbis" | "aac" | "mp3" | "other";

export type EngineSettingsView = {
  autoAcceptScore: number;
  reviewScore: number;
  verifyDuration: boolean;
  verifyFingerprint: boolean;
  sourcePriority: CatalogProviderId[];
  disabledSources: CatalogProviderId[];
  wantedEnabled: boolean;
  wantedIntervalMinutes: number;
  followCheckHours: number;
  autoDownloadFollowedReleases: boolean;
};

export type QualitySettingsView = {
  minimumBitrateKbps: Record<QualityCodecFamily, number>;
};

export type MusicBrainzSettingsView = {
  textSearchEnabled: boolean;
  maxTextLookupsPerScan: number;
  catalogSource: "musicbrainz" | "spotify";
};

export type NavidromeSettingsView = {
  baseUrl: string;
  username: string;
  passwordSet: boolean;
};

export type SpotifySettingsView = {
  enabled: boolean;
  clientId: string;
  clientSecretSet: boolean;
  market: string;
};

export type IdentificationSettingsView = {
  acoustIdEnabled: boolean;
  acoustIdApiKeySet: boolean;
  useEmbeddedTagsAsHints: boolean;
  usePathAsHints: boolean;
  autoAcceptUniqueFingerprintMatches: boolean;
  requireReviewBeforeFileChanges: boolean;
};

export type ProviderSettingsView = {
  maxConcurrentDownloads: number;
  opusQuality: 160 | 192 | 256;
  mp3FallbackEnabled: boolean;
  mp3FallbackQuality: 192 | 256 | 320;
};

export type DiscoverySettingsView = {
  requestsPerMinute: number;
};

export type CatalogSettingsView = {
  spotify: SpotifySettingsView;
  providers: ProviderSettingsView;
  discovery: DiscoverySettingsView;
};

export type SpotifyArtistSummary = {
  id: string;
  name: string;
  imageUrl: string | null;
  spotifyUrl: string;
};

export type SpotifyAlbumSummary = {
  id: string;
  name: string;
  albumType: string;
  releaseYear: number | null;
  releaseDate: string;
  totalTracks: number;
  imageUrl: string | null;
  spotifyUrl: string;
};

export type SpotifyTrackSummary = {
  id: string;
  name: string;
  artists: string[];
  discNumber: number;
  trackNumber: number;
  duration: number;
  explicit: boolean;
  isrc: string | null;
  spotifyUrl: string;
  present: boolean;
};

export type SpotifyMetadataMatch = {
  id: string;
  name: string;
  artists: string[];
  albumArtist: string;
  albumId: string;
  album: string;
  albumType: string;
  releaseDate: string;
  releaseYear: number | null;
  imageUrl: string | null;
  discNumber: number;
  trackNumber: number;
  duration: number;
  isrc: string | null;
  spotifyUrl: string;
};

export type SpotifyMetadataSearchResult = {
  query: string;
  matches: SpotifyMetadataMatch[];
};

export type SpotifyAlbumDetail = SpotifyAlbumSummary & {
  artist: SpotifyArtistSummary;
  tracks: SpotifyTrackSummary[];
  localTrackCount: number;
};

export type SpotifyArtistDiscography = {
  artist: SpotifyArtistSummary;
  albums: Array<SpotifyAlbumSummary & { localTrackCount: number }>;
};

export type SpotifyCatalogMatch = {
  localArtistId: string;
  localArtistName: string;
  spotifyArtist: SpotifyArtistSummary | null;
  message: string;
};

export type SpotifyTestResult = {
  ok: boolean;
  message: string;
};

export type SpotifyCatalogArtistSearchResult = {
  artists: SpotifyArtistSummary[];
};

export type SpotifyCatalogArtistMatchesResult = {
  matches: SpotifyCatalogMatch[];
};

export type SpotifyCatalogDiscographyResult = SpotifyArtistDiscography;

export type SpotifyCatalogAlbumResult = {
  album: SpotifyAlbumDetail;
};

export type SpotifyCatalogDownloadSelection = {
  spotifyAlbumId: string;
  trackIds?: string[];
};

export type SpotifyCatalogDownloadPlan = {
  album: SpotifyAlbumDetail;
  selectedTracks: SpotifyTrackSummary[];
  supportedProviders: string[];
  warnings: string[];
};

export type SpotifyCatalogDownloadQueueRequest = {
  spotifyAlbumId: string;
  trackIds?: string[];
  reviewedCandidates?: Array<{
    candidate: CatalogProviderCandidate;
    trackId: string;
  }>;
  rightsConfirmed?: boolean;
};

export type CatalogProviderId = "jiosaavn" | "youtube";

export type CatalogProviderCandidateScore = {
  albumScore?: number;
  artistScore: number;
  durationDeltaMs?: number;
  overall: number;
  titleScore: number;
};

export type CatalogProviderCandidate = {
  album?: string;
  artists: string[];
  durationMs?: number;
  id: string;
  providerId: CatalogProviderId;
  score: CatalogProviderCandidateScore;
  title: string;
  url: string;
  verified: boolean;
  /** Scoring notes such as "topic-channel", "isrc-match", or "version:live". */
  flags?: string[];
  channel?: string;
};

/** One track to acquire, independent of whether MusicBrainz or Spotify described it. */
export type DownloadTrack = {
  /** Stable identity: "mb:<recordingId>" / "mb:<releaseTrackId>" or "spotify:<trackId>". */
  key: string;
  catalog: "musicbrainz" | "spotify";
  title: string;
  artists: string[];
  album: string;
  albumArtist: string;
  albumType: string;
  trackNumber: number;
  discNumber: number;
  trackTotal: number | null;
  discTotal: number | null;
  releaseDate: string;
  releaseYear: number | null;
  durationMs: number;
  isrc: string | null;
  coverUrl: string | null;
  musicbrainz?: TrackMusicBrainzIds;
  spotify?: { trackId: string; albumId: string; url: string };
};

export type DownloadJobStatus = "queued" | "running" | "review" | "completed" | "partial" | "failed" | "cancelled";

export type DownloadItemStatus =
  | "pending"
  | "searching"
  | "review"
  | "downloading"
  | "verifying"
  | "completed"
  | "skipped"
  | "failed"
  | "cancelled";

export type DownloadVerification = {
  durationDeltaSeconds: number | null;
  sourceBitrateKbps: number | null;
  sourceCodec: string | null;
  fingerprint: "match" | "mismatch" | "inconclusive" | "skipped";
  acoustIdScore: number | null;
  notes: string[];
};

export type DownloadAttempt = {
  candidateId: string;
  at: string;
  reason: "duration-mismatch" | "fingerprint-mismatch" | "low-quality" | "download-failed" | "not-better";
  message: string;
};

export type DownloadJobItem = {
  id: string;
  track: DownloadTrack;
  status: DownloadItemStatus;
  candidates: CatalogProviderCandidate[];
  selectedCandidateId?: string;
  attempts: DownloadAttempt[];
  verification?: DownloadVerification;
  message?: string;
  error?: string;
  targetRelativePath: string;
  relativePath?: string;
  /** Set when a person approved the selected candidate in the review queue. */
  approvedByUser?: boolean;
  /** Library track this download is meant to replace (quality upgrades). */
  replaceTrackId?: string;
  startedAt?: string;
  completedAt?: string;
};

export type DownloadJob = {
  id: string;
  title: string;
  subtitle: string;
  origin: "manual" | "wanted" | "follow" | "upgrade";
  catalog: "musicbrainz" | "spotify";
  coverUrl: string | null;
  status: DownloadJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  counts: Record<DownloadItemStatus, number> & { total: number };
  items: DownloadJobItem[];
};

export type DownloadJobSummary = Omit<DownloadJob, "items">;

export type DownloadReviewItem = {
  jobId: string;
  jobTitle: string;
  item: DownloadJobItem;
};

export type WantedStatus = "waiting" | "searching" | "paused" | "found";

export type WantedItem = {
  id: string;
  track: DownloadTrack;
  status: WantedStatus;
  attempts: number;
  reason: string;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
};

export type QuarantineEntry = {
  candidateId: string;
  trackKey: string;
  reason: string;
  detail: string;
  createdAt: string;
};

export type FollowedArtist = {
  artistId: string;
  name: string;
  disambiguation: string;
  autoDownload: boolean;
  createdAt: string;
  lastCheckedAt: string | null;
  newReleaseCount: number;
};

export type ArtistRelease = {
  id: string;
  artistId: string;
  artistName: string;
  title: string;
  primaryType: string;
  secondaryTypes: string[];
  firstReleaseDate: string;
  status: "new" | "existing" | "dismissed" | "queued";
  seen: boolean;
  firstSeenAt: string;
  inLibrary: boolean;
};

export type CatalogArtistSummary = {
  id: string;
  name: string;
  disambiguation: string;
  country: string;
  type: string;
  score: number;
  lifeSpan: string;
  localTrackCount: number;
};

export type CatalogReleaseGroup = {
  id: string;
  title: string;
  primaryType: string;
  secondaryTypes: string[];
  firstReleaseDate: string;
  year: number | null;
  coverUrl: string;
  artistCredit: string;
  localTrackCount: number;
};

export type CatalogArtistView = {
  artist: CatalogArtistSummary & { genres: string[] };
  followed: boolean;
  releaseGroups: CatalogReleaseGroup[];
};

export type CatalogEdition = {
  id: string;
  title: string;
  date: string;
  country: string;
  status: string;
  formats: string[];
  trackCount: number;
  disambiguation: string;
};

export type CatalogTrack = {
  /** Release track MBID, used to select tracks for download. */
  id: string;
  recordingId: string;
  title: string;
  artists: string[];
  discNumber: number;
  trackNumber: number;
  duration: number | null;
  isrc: string | null;
  present: boolean;
  queued: boolean;
};

export type CatalogReleaseView = {
  releaseGroup: CatalogReleaseGroup;
  release: CatalogEdition & { artist: string; artistIds: string[]; coverUrl: string; labels: string[] };
  preferredReleaseId: string;
  editions: CatalogEdition[];
  tracks: CatalogTrack[];
  localTrackCount: number;
};

export type UpgradeCandidate = {
  track: TrackFile;
  codecFamily: QualityCodecFamily;
  bitrateKbps: number | null;
  minimumKbps: number;
  reason: string;
};

export type UpgradeView = {
  totalTracks: number;
  candidates: UpgradeCandidate[];
};

export type EngineStatus = {
  activeJobs: number;
  reviewCount: number;
  wantedCount: number;
  newReleaseCount: number;
  sources: Array<{ id: CatalogProviderId; label: string; available: boolean; enabled: boolean; message: string }>;
};

/** Messages streamed to the browser over /api/events. */
export type ServerEvent =
  | { type: "scan"; status: ScanStatus }
  | { type: "download-job"; job: DownloadJobSummary }
  | { type: "download-item"; jobId: string; item: DownloadJobItem }
  | { type: "engine"; status: EngineStatus }
  | { type: "catalog-changed"; updatedAt: string | null }
  | { type: "convert-job"; job: AudioConvertJob };

export type SpotifyCatalogDownloadPreviewItem = {
  candidates: CatalogProviderCandidate[];
  error?: string;
  selectedCandidate: CatalogProviderCandidate | null;
  targetRelativePath: string;
  track: SpotifyTrackSummary;
};

export type SpotifyCatalogDownloadPreviewResult = {
  album: SpotifyAlbumDetail;
  downloadableCount: number;
  failedCount: number;
  generatedAt: string;
  items: SpotifyCatalogDownloadPreviewItem[];
  warnings: string[];
};

export type SpotifyCatalogDownloadJobStatus = "completed" | "failed" | "queued" | "running";

export type SpotifyCatalogDownloadJobItemStatus =
  | "completed"
  | "downloading"
  | "failed"
  | "pending";

export type SpotifyCatalogDownloadJobItem = {
  candidate: CatalogProviderCandidate | null;
  completedAt?: string;
  destinationPath?: string;
  error?: string;
  relativePath?: string;
  startedAt?: string;
  status: SpotifyCatalogDownloadJobItemStatus;
  targetRelativePath: string;
  track: SpotifyTrackSummary;
};

export type SpotifyCatalogDownloadJob = {
  completedAt?: string;
  completedCount: number;
  createdAt: string;
  failedCount: number;
  id: string;
  items: SpotifyCatalogDownloadJobItem[];
  pendingCount: number;
  status: SpotifyCatalogDownloadJobStatus;
  totalCount: number;
  updatedAt: string;
};

export type SpotifyCatalogDownloadQueueResult = {
  job: SpotifyCatalogDownloadJob;
  preview: SpotifyCatalogDownloadPreviewResult;
};

export type NamingSettings = {
  mode: NamingMode;
  libraryPath: string;
  recycleBinPath: string;
  artistFolderFormat: string;
  standardTrackFormat: string;
  multiDiscTrackFormat: string;
  replaceIllegalCharacters: boolean;
  colonReplacementFormat: number;
};

export type NamingMode = "standard";

export type ScanSettings = {
  extensions: string[];
  autoScanEnabled: boolean;
  autoScanTime: string;
};

export type CleanupSettings = {
  emptyFolderExclusions: string[];
};

export type SettingsView = {
  auth: {
    enabled: boolean;
    username: string;
  };
  navidrome: NavidromeSettingsView;
  catalog: CatalogSettingsView;
  identification: IdentificationSettingsView;
  naming: NamingSettings;
  scan: ScanSettings;
  cleanup: CleanupSettings;
  engine: EngineSettingsView;
  quality: QualitySettingsView;
  musicbrainz: MusicBrainzSettingsView;
};

export type SettingsUpdate = {
  auth?: {
    enabled?: boolean;
    username?: string;
    password?: string;
  };
  navidrome?: {
    baseUrl?: string;
    username?: string;
    password?: string;
  };
  catalog?: {
    spotify?: {
      enabled?: boolean;
      clientId?: string;
      clientSecret?: string;
      market?: string;
    };
    providers?: Partial<ProviderSettingsView>;
    discovery?: Partial<DiscoverySettingsView>;
  };
  identification?: {
    acoustIdEnabled?: boolean;
    acoustIdApiKey?: string;
    useEmbeddedTagsAsHints?: boolean;
    usePathAsHints?: boolean;
    autoAcceptUniqueFingerprintMatches?: boolean;
    requireReviewBeforeFileChanges?: boolean;
  };
  naming?: Partial<NamingSettings>;
  scan?: Partial<ScanSettings>;
  cleanup?: Partial<CleanupSettings>;
  engine?: Partial<EngineSettingsView>;
  quality?: { minimumBitrateKbps?: Partial<Record<QualityCodecFamily, number>> };
  musicbrainz?: Partial<MusicBrainzSettingsView>;
};

export type NavidromeMetadataMatchMethod =
  | "absolute-path"
  | "relative-path"
  | "filename-size"
  | "metadata-key"
  | "metadata-size-relaxed-duration"
  | "edition-metadata-size"
  | "metadata-size-title-suffix"
  | "edition-title-suffix-metadata-size"
  | "metadata-size-track-agnostic"
  | "metadata-size-artist-agnostic";

export type NavidromeMetadataDiagnosticCode =
  | "matched"
  | "settings-missing"
  | "api-request-failed"
  | "zero-tracks"
  | "track-no-usable-path"
  | "path-outside-library-root"
  | "spotify-confirmed"
  | "identity-confirmed"
  | "no-api-match"
  | "possible-stale-scan";

export type NavidromeMetadataEnrichment = {
  status: "matched" | "skipped" | "unmatched";
  code: NavidromeMetadataDiagnosticCode;
  message: string;
  matchMethod?: NavidromeMetadataMatchMethod;
  indexedTrackCount?: number;
};

/** `spotifybu` is retained only for persisted/external data from before the TrackKeep rename. */
export type TrackManager = "trackkeep" | "spotifybu";

export type TrackIdentificationStatus =
  | "trackkeep-confirmed"
  | "user-confirmed"
  | "musicbrainz-tagged"
  | "fingerprint-and-release-confirmed"
  | "recording-identified-release-ambiguous"
  | "candidate-only"
  | "unidentified";

export type TrackMetadataSource = "trackkeep" | "spotify" | "musicbrainz" | "local-tags" | "local-path" | "unknown";

export type TrackIdentificationCandidate = {
  id: string;
  score: number;
  acoustId: string;
  recordingId: string;
  releaseId: string | null;
  releaseGroupId: string | null;
  artist: string;
  albumArtist: string;
  album: string;
  albumType: string;
  title: string;
  trackNumber: number | null;
  trackTotal: number | null;
  discNumber: number | null;
  discTotal: number | null;
  year: number | null;
  duration: number | null;
  isrc: string | null;
  releaseTrackId?: string;
  artistIds?: string[];
  albumArtistIds?: string[];
};

export type TrackIdentification = {
  status: TrackIdentificationStatus;
  source: TrackMetadataSource;
  message: string;
  fingerprint?: string;
  acoustId?: string;
  recordingId?: string;
  releaseId?: string;
  releaseGroupId?: string;
  spotifyTrackId?: string;
  spotifyAlbumId?: string;
  candidates?: TrackIdentificationCandidate[];
  /** How the candidates were found: audio fingerprint or MusicBrainz text search. */
  candidateSource?: "acoustid" | "musicbrainz-search";
};

/** MusicBrainz identifiers carried in a file's tags (Picard conventions). */
export type TrackMusicBrainzIds = {
  recordingId?: string;
  releaseTrackId?: string;
  releaseId?: string;
  releaseGroupId?: string;
  artistIds?: string[];
  albumArtistIds?: string[];
};

export type TrackFile = {
  id: string;
  absolutePath: string;
  relativePath: string;
  extension: string;
  size: number;
  mtimeMs: number;
  artist: string;
  albumArtist: string;
  album: string;
  albumType: string;
  title: string;
  trackNumber: number | null;
  trackTotal: number | null;
  discNumber: number | null;
  discTotal: number | null;
  year: number | null;
  duration: number | null;
  isrc?: string | null;
  bitrate: number | null;
  sampleRate: number | null;
  bitsPerSample: number | null;
  codec: string | null;
  container: string | null;
  lossless: boolean;
  duplicateKey: string;
  qualityScore: number;
  targetPath: string;
  targetRelativePath: string;
  targetSource?: "naviclean" | "navidrome" | "spotify" | "musicbrainz";
  metadataConfidence?: "embedded" | "path-suggestion" | "trusted-path" | "navidrome" | "spotify" | "musicbrainz";
  metadataSuggestion?: TrackMetadataSuggestion;
  identification?: TrackIdentification;
  navidromeEnrichment?: NavidromeMetadataEnrichment;
  managedBy?: TrackManager;
  organizeSkippedAt?: string;
  musicbrainz?: TrackMusicBrainzIds;
  issues: string[];
};

export type TrackMetadataSuggestion = {
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  title: string | null;
  trackNumber: number | null;
  discNumber: number | null;
  year: number | null;
};

export type WorkflowStage = "scan" | "organize" | "duplicates";

export type WorkflowState = {
  stage: WorkflowStage;
  duplicateScanReady: boolean;
  scanned: boolean;
  pendingMoves: number;
  organizationConflicts: number;
  metadataReview: number;
  missingFiles: number;
  message: string;
  warnings: string[];
};

export type DuplicateGroup = {
  key: string;
  tracks: TrackFile[];
  suggestedKeepId: string;
  reason: string;
};

export type ScanStatus = {
  phase?: "discovering" | "metadata" | "identifying" | "searching" | "navidrome" | "saving" | "complete" | "failed" | "cancelled";
  /** Files whose tags were reused from the cache because size and mtime were unchanged. */
  cachedFiles?: number;
  progressAt?: string;
  processedFiles?: number;
  totalFiles?: number;
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  scannedFiles: number;
  audioFiles: number;
  errors: string[];
  warnings: string[];
};

export type NavidromeScanStatus = {
  configured: boolean;
  running: boolean;
  count: number;
  folderCount: number;
  lastScan: string | null;
  error: string | null;
  scanType: string | null;
  elapsedSeconds: number | null;
};

export type LibraryStats = {
  totalTracks: number;
  duplicateGroups: number;
  duplicateTracks: number;
  pendingMoves: number;
  missingMetadata: number;
  lastScanFinishedAt: string | null;
  workflow: WorkflowState;
};

export type LibraryArtistSummary = {
  id: string;
  name: string;
  thumbnailLabel: string;
  artworkUrl: string | null;
  albumCount: number;
  trackCount: number;
  totalSize: number;
  formats: string[];
  issueCount: number;
};

export type LibraryAlbumSummary = {
  id: string;
  artistId: string;
  artist: string;
  title: string;
  albumType: string;
  yearLabel: string;
  thumbnailLabel: string;
  artworkUrl: string | null;
  trackCount: number;
  totalSize: number;
  duration: number | null;
  formats: string[];
  issueCount: number;
};

export type LibraryTrashResult = {
  trashed: number;
  removedTrackIds: string[];
  errors: string[];
};

export type AudioConvertTargetFormat = "mp3" | "flac" | "m4a" | "opus" | "ogg" | "wav";

export type AudioConvertQuality = "128k" | "192k" | "256k" | "320k" | "lossless";

export type AudioConvertFile = {
  id: string;
  relativePath: string;
  extension: string;
  size: number;
  artist: string;
  album: string;
  title: string;
  duration: number | null;
  bitrate: number | null;
  lossless: boolean;
};

export type AudioConvertExtensionGroup = {
  extension: string;
  count: number;
  totalSize: number;
  files: AudioConvertFile[];
};

export type AudioConvertView = {
  libraryPath: string;
  totalFiles: number;
  totalSize: number;
  groups: AudioConvertExtensionGroup[];
};

export type AudioConvertJobStatus = "queued" | "running" | "completed" | "failed";

export type AudioConvertJobItemStatus = "pending" | "converting" | "completed" | "failed";

export type AudioConvertJobItem = {
  trackId: string;
  sourceRelativePath: string;
  targetRelativePath: string;
  sourceSize: number;
  outputSize: number | null;
  progress: number;
  status: AudioConvertJobItemStatus;
  error?: string;
  startedAt?: string;
  completedAt?: string;
};

export type AudioConvertJob = {
  id: string;
  sourceExtension: string;
  targetFormat: AudioConvertTargetFormat;
  quality: AudioConvertQuality;
  status: AudioConvertJobStatus;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  pendingCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  errors: string[];
  items: AudioConvertJobItem[];
};

export type UnindexedFilesView = {
  libraryPath: string;
  total: number;
  totalSize: number;
  counts: {
    noApiMatch: number;
    possibleStaleScan: number;
    other: number;
  };
  tracks: TrackFile[];
};

export type UnindexedTrashResult = LibraryTrashResult & {
  unindexed: UnindexedFilesView;
};

export type UnindexedNavidromeComparisonStatus = "match" | "different" | "unavailable";

export type UnindexedNavidromeCandidate = {
  id: string;
  score: number;
  acceptedBy: NavidromeMetadataMatchMethod | null;
  rejectedReasons: string[];
  checks: {
    absolutePath: UnindexedNavidromeComparisonStatus;
    relativePath: UnindexedNavidromeComparisonStatus;
    filenameSize: UnindexedNavidromeComparisonStatus;
    metadataKey: UnindexedNavidromeComparisonStatus;
  };
  navidrome: {
    path: string | null;
    relativePath: string | null;
    pathStatus: "usable" | "missing" | "outside-library-root";
    artist: string;
    albumArtist: string;
    album: string;
    title: string;
    trackNumber: number | null;
    discNumber: number | null;
    year: number | null;
    duration: number | null;
    size: number | null;
    isrc: string | null;
  };
};

export type UnindexedNavidromeLookupResult = {
  query: string;
  track: TrackFile;
  candidates: UnindexedNavidromeCandidate[];
  message: string;
};

export type EmptyFolderItem = {
  id: string;
  relativePath: string;
  name: string;
  parentRelativePath: string;
  depth: number;
  mtimeMs: number;
};

export type EmptyFolderPreview = {
  libraryPath: string;
  total: number;
  folders: EmptyFolderItem[];
  errors: string[];
};

export type EmptyFolderDeleteResult = {
  deleted: number;
  errors: string[];
  emptyFolders: EmptyFolderPreview;
};

export type EmptyFolderExcludeResult = {
  emptyFolders: EmptyFolderPreview;
  exclusions: string[];
};

export type NonMusicFileClassification = "useful" | "junk" | "review";

export type NonMusicFileExample = {
  relativePath: string;
  size: number;
  mtimeMs: number;
};

export type NonMusicFileItem = NonMusicFileExample & {
  id: string;
  extension: string;
  filename: string;
};

export type NonMusicFileGroup = {
  key: string;
  label: string;
  classification: NonMusicFileClassification;
  description: string;
  count: number;
  totalSize: number;
  examples: NonMusicFileExample[];
};

export type NonMusicFilesView = {
  libraryPath: string;
  totalFiles: number;
  audioFiles: number;
  nonMusicFiles: number;
  totalSize: number;
  groups: NonMusicFileGroup[];
  errors: string[];
};

export type NonMusicFileGroupDetail = {
  group: NonMusicFileGroup;
  files: NonMusicFileItem[];
  errors: string[];
};

export type NonMusicTrashResult = {
  trashed: number;
  trashedBytes: number;
  errors: string[];
  nonMusicFiles: NonMusicFilesView;
};

export type NonMusicFileTrashResult = NonMusicTrashResult & {
  group: NonMusicFileGroupDetail | null;
};

export type RecycleBinItem = {
  id: string;
  itemType: "file" | "folder";
  relativePath: string;
  originalRelativePath: string;
  deletedGroup: string;
  deletedAt: string | null;
  extension: string;
  size: number;
  mtimeMs: number;
};

export type RecycleBinView = {
  recycleBinPath: string;
  totalFiles: number;
  totalSize: number;
  items: RecycleBinItem[];
};

export type RecycleBinDeleteResult = {
  deletedFiles: number;
  deletedBytes: number;
  errors: string[];
  recycleBin: RecycleBinView;
};

export type RecycleBinRestoreResult = {
  restoredFiles: number;
  restoredBytes: number;
  errors: string[];
  recycleBin: RecycleBinView;
};

export type OrganizePlanItem = {
  id: string;
  sourcePath: string;
  targetPath: string;
  sourceRelativePath: string;
  targetRelativePath: string;
  targetSource?: "naviclean" | "navidrome" | "spotify" | "musicbrainz";
  navidromeEnrichment?: NavidromeMetadataEnrichment;
  managedBy?: TrackManager;
  organizeSkippedAt?: string;
  metadataConfidence?: TrackFile["metadataConfidence"];
  metadataSuggestion?: TrackMetadataSuggestion;
  identification?: TrackIdentification;
  artist: string;
  albumArtist: string;
  album: string;
  title: string;
  trackNumber: number | null;
  year: number | null;
  status: "ready" | "same" | "skipped" | "metadata-review" | "duplicate-target" | "conflict" | "outside-library" | "missing-source";
  message: string;
  collision?: OrganizeCollision;
};

export type OrganizeSpotifyMatchResult = {
  matchedTracks: number;
  updatedTrackIds: string[];
  selected: SpotifyMetadataMatch;
  plan: OrganizePlan;
};

export type OrganizeIdentificationMatchResult = {
  updatedTrackIds: string[];
  plan: OrganizePlan;
};

export type OrganizeTrustPathResult = {
  trustedTracks: number;
  updatedTrackIds: string[];
  plan: OrganizePlan;
};

export type OrganizeSkipResult = {
  skipped: boolean;
  updatedTrackIds: string[];
  plan: OrganizePlan;
};

export type OrganizeCollision = {
  duplicateKeyMatches: boolean;
  candidates: OrganizeCollisionCandidate[];
};

export type OrganizeCollisionCandidate = {
  id: string;
  trackId: string | null;
  role: "source" | "same-target" | "existing-target";
  absolutePath: string;
  relativePath: string;
  targetRelativePath: string;
  artist: string;
  albumArtist: string;
  album: string;
  albumType: string;
  title: string;
  extension: string;
  size: number | null;
  duration: number | null;
  bitrate: number | null;
  sampleRate: number | null;
  bitsPerSample: number | null;
  codec: string | null;
  container: string | null;
  lossless: boolean;
  qualityScore: number | null;
  duplicateKey: string;
};

export type OrganizePlan = {
  items: OrganizePlanItem[];
  /** Hash of the ready moves; Apply must echo it back so a changed plan is never applied blind. */
  fingerprint: string;
  warnings: string[];
  summary: {
    ready: number;
    same: number;
    duplicateTargets: number;
    conflicts: number;
    metadataReview: number;
    missing: number;
    skipped: number;
  };
};

export type OrganizeApplyResult = {
  moved: number;
  skipped: number;
  errors: string[];
  items: Array<OrganizePlanItem & { applied: boolean }>;
  plan: OrganizePlan;
};

export type OrganizeTrashResult = {
  trashed: number;
  removedTrackIds: string[];
  errors: string[];
  plan: OrganizePlan;
};

export type OrganizeTrashSelection = {
  itemId: string;
  candidateId: string;
};

export type DuplicateResolveResult = {
  keptId: string;
  trashed: number;
  errors: string[];
};

export type DuplicateBulkResolveResult = {
  trashed: number;
  removedTrackIds: string[];
  errors: string[];
};
