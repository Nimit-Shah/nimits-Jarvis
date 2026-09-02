"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type AppTheme = "solar-dusk" | "zen-linen";

const STORAGE_KEY = "jarvis-theme";
const DEFAULT_THEME: AppTheme = "solar-dusk";

interface AppThemeContextValue {
  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;
}

const AppThemeContext = createContext<AppThemeContextValue>({
  theme: DEFAULT_THEME,
  setTheme: () => {},
});

export function useAppTheme() {
  return useContext(AppThemeContext);
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<AppTheme>(DEFAULT_THEME);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as AppTheme | null;
      const initial =
        stored === "zen-linen" || stored === "solar-dusk" ? stored : DEFAULT_THEME;
      setThemeState(initial);
      document.documentElement.setAttribute("data-theme", initial);
    } catch {
      // storage unavailable (SSR/private mode) — keep default
    }
  }, []);

  const setTheme = (next: AppTheme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore write failures
    }
    document.documentElement.setAttribute("data-theme", next);
  };

  // Avoid hydration mismatch by rendering children even before mounted;
  // the pre-hydration script in layout.tsx already set the attribute.
  // We keep the provider mounted always.

  return (
    <AppThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </AppThemeContext.Provider>
  );
}

// Helper for non-React contexts (e.g., pre-hydration verification)
export function getStoredAppTheme(): AppTheme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const v = localStorage.getItem(STORAGE_KEY) as AppTheme | null;
    if (v === "solar-dusk" || v === "zen-linen") return v;
  } catch {}
  return DEFAULT_THEME;
}

export const APP_THEMES: Array<{
  value: AppTheme;
  label: string;
  description: string;
}> = [
  {
    value: "solar-dusk",
    label: "Solar Dusk",
    description: "Warm amber & stone — default",
  },
  {
    value: "zen-linen",
    label: "Zen Linen",
    description: "Soft linen neutrals — calm & minimal",
  },
];
