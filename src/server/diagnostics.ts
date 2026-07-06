const enabledValues = new Set(["1", "true", "yes", "on"]);

export function advancedDiagnosticsEnabled() {
  return enabledValues.has(String(process.env.NAVICLEAN_ADVANCED_DIAGNOSTICS || "").trim().toLowerCase());
}
