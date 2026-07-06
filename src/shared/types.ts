export type AuthInfo = {
  authEnabled: boolean;
  authenticated: boolean;
  username: string | null;
};

export type NavidromeSettingsView = {
  baseUrl: string;
  username: string;
  passwordSet: boolean;
};

export type SpotifySettingsView = {
  clientId: string;
  clientSecretSet: boolean;
  market: string;
};

export type ProviderSettingsView = {
  maxConcurrentDownloads: number;
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
};

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
  naming: NamingSettings;
  scan: ScanSettings;
  cleanup: CleanupSettings;
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
      clientId?: string;
      clientSecret?: string;
      market?: string;
    };
    providers?: Partial<ProviderSettingsView>;
    discovery?: Partial<DiscoverySettingsView>;
  };
  naming?: Partial<NamingSettings>;
  scan?: Partial<ScanSettings>;
  cleanup?: Partial<CleanupSettings>;
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
  | "no-api-match"
  | "possible-stale-scan";

export type NavidromeMetadataEnrichment = {
  status: "matched" | "skipped" | "unmatched";
  code: NavidromeMetadataDiagnosticCode;
  message: string;
  matchMethod?: NavidromeMetadataMatchMethod;
  indexedTrackCount?: number;
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
  targetSource?: "naviclean" | "navidrome" | "spotify";
  navidromeEnrichment?: NavidromeMetadataEnrichment;
  managedBy?: "spotifybu";
  issues: string[];
};

export type WorkflowStage = "scan" | "organize" | "duplicates";

export type WorkflowState = {
  stage: WorkflowStage;
  duplicateScanReady: boolean;
  scanned: boolean;
  pendingMoves: number;
  organizationConflicts: number;
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
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  scannedFiles: number;
  audioFiles: number;
  errors: string[];
  warnings: string[];
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
  targetSource?: "naviclean" | "navidrome" | "spotify";
  navidromeEnrichment?: NavidromeMetadataEnrichment;
  managedBy?: "spotifybu";
  status: "ready" | "same" | "duplicate-target" | "conflict" | "outside-library" | "missing-source";
  message: string;
  collision?: OrganizeCollision;
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
  warnings: string[];
  summary: {
    ready: number;
    same: number;
    duplicateTargets: number;
    conflicts: number;
    missing: number;
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
