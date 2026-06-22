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

export type NamingMode = "standard" | "manual";

export type ScanSettings = {
  extensions: string[];
};

export type SettingsView = {
  auth: {
    enabled: boolean;
    username: string;
  };
  navidrome: NavidromeSettingsView;
  naming: NamingSettings;
  scan: ScanSettings;
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
  naming?: Partial<NamingSettings>;
  scan?: Partial<ScanSettings>;
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

export type RecycleBinItem = {
  id: string;
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

export type OrganizePlanItem = {
  id: string;
  sourcePath: string;
  targetPath: string;
  sourceRelativePath: string;
  targetRelativePath: string;
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
  plan?: OrganizePlan;
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
