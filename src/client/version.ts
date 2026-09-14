export const appVersion = {
  version: "0.6.1",
  branch: import.meta.env?.VITE_APP_BRANCH || "unknown"
} as const;
