import { useEffect, useState } from "react";

export type AppTheme = "light" | "dark";

const themeStorageKey = "naviclean-theme";

export function useTheme() {
  const [theme, setTheme] = useState<AppTheme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem(themeStorageKey, theme);
    } catch {
      // The theme still applies for this session.
    }
  }, [theme]);

  return [theme, setTheme] as const;
}

function initialTheme(): AppTheme {
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // Fall through to the system preference.
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
