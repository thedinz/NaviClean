export const appVersion = {
  version: "0.7.2",
  branch: import.meta.env?.VITE_APP_BRANCH || "unknown"
} as const;
