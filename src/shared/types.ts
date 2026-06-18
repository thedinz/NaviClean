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
  libraryPath: string;
  recycleBinPath: string;
  artistFolderFormat: string;
  standardTrackFormat: string;
  multiDiscTrackFormat: string;
  replaceIllegalCharacters: boolean;
};

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
};

export type OrganizePlanItem = {
  id: string;
  sourcePath: string;
  targetPath: string;
  sourceRelativePath: string;
  targetRelativePath: string;
  status: "ready" | "same" | "conflict" | "outside-library" | "missing-source";
  message: string;
};

export type OrganizePlan = {
  items: OrganizePlanItem[];
  summary: {
    ready: number;
    same: number;
    conflicts: number;
    missing: number;
  };
};

export type OrganizeApplyResult = {
  moved: number;
  skipped: number;
  errors: string[];
  items: Array<OrganizePlanItem & { applied: boolean }>;
};

export type DuplicateResolveResult = {
  keptId: string;
  trashed: number;
  errors: string[];
};

