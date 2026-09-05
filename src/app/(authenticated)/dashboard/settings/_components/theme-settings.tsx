"use client";

import { useState } from "react";
import { Check, Palette } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { APP_THEMES, useAppTheme, type AppTheme } from "~/components/core/app-theme-provider";
import { showSuccessToast } from "~/components/core/toast-notifications";
import { cn } from "~/lib/utils";

/**
 * Fixed preview tokens per theme (mirrors src/styles/globals.css).
 * Kept local so each swatch renders in its own palette regardless of the
 * currently active theme.
 */
const THEME_SWATCHES: Record<AppTheme, { bg: string; sidebar: string; primary: string; text: string }> = {
  "solar-dusk": { bg: "#FDFBF7", sidebar: "#F1E9DA", primary: "#B45309", text: "#4A3B33" },
  "zen-linen": { bg: "#E9E4D8", sidebar: "#E3DDCF", primary: "#2E2E2E", text: "#1E1E1E" },
};

export function ThemeSettings() {
  const { theme, setTheme } = useAppTheme();
  const [applying, setApplying] = useState(false);

  const handleSelect = (next: AppTheme) => {
    if (next === theme || applying) return;
    setApplying(true);
    setTheme(next);
    showSuccessToast(`Theme changed to ${APP_THEMES.find((t) => t.value === next)?.label ?? next}`);
    // Ensure all components pick up the new theme vars.
    // CSS vars update live via data-theme attribute, but reload guarantees
    // any component that cached computed styles or floating portals re-render
    // with the new tokens (especially floating dev tools outside React tree).
    setTimeout(() => {
      window.location.reload();
    }, 300);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Palette className="size-4" />
          Appearance
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3" role="group" aria-label="Appearance">
          {APP_THEMES.map((t) => {
            const swatch = THEME_SWATCHES[t.value];
            const selected = t.value === theme;
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => handleSelect(t.value)}
                disabled={applying}
                aria-pressed={selected}
                title={t.description}
                className={cn(
                  "group rounded-lg border p-2 text-left transition-all",
                  "hover:border-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected ? "border-primary ring-1 ring-primary" : "border-border/60",
                )}
              >
                {/* Mini preview in the theme's own palette */}
                <span
                  className="flex h-16 overflow-hidden rounded-md"
                  style={{ backgroundColor: swatch.bg }}
                  aria-hidden="true"
                >
                  <span className="w-1/4 shrink-0" style={{ backgroundColor: swatch.sidebar }} />
                  <span className="flex flex-1 flex-col justify-center gap-1.5 px-2.5">
                    <span className="h-1.5 w-3/4 rounded-full" style={{ backgroundColor: swatch.text, opacity: 0.55 }} />
                    <span className="h-1.5 w-1/2 rounded-full" style={{ backgroundColor: swatch.text, opacity: 0.3 }} />
                    <span className="mt-0.5 h-2 w-2 rounded-full" style={{ backgroundColor: swatch.primary }} />
                  </span>
                </span>
                {/* Label row: name + selected check */}
                <span className="mt-2 flex items-center justify-between px-0.5">
                  <span className="text-[12px] font-medium text-foreground">{t.label}</span>
                  {selected && <Check className="size-3.5 text-primary" aria-label="Selected" />}
                </span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
