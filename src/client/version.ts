export const appVersion = {
  version: "0.7.0",
  branch: import.meta.env?.VITE_APP_BRANCH || "unknown"
} as const;
