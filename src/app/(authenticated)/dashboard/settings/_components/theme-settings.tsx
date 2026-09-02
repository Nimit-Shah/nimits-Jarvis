"use client";

import { useEffect, useState } from "react";
import { Palette, Save } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { APP_THEMES, useAppTheme, type AppTheme } from "~/components/core/app-theme-provider";
import { showSuccessToast } from "~/components/core/toast-notifications";

export function ThemeSettings() {
  const { theme: persistedTheme, setTheme } = useAppTheme();
  const [draft, setDraft] = useState<AppTheme>(persistedTheme);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(persistedTheme);
  }, [persistedTheme]);

  const hasChange = draft !== persistedTheme;

  const handleSave = () => {
    setSaving(true);
    setTheme(draft);
    showSuccessToast(`Theme changed to ${APP_THEMES.find((t) => t.value === draft)?.label ?? draft}`);
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
        <CardDescription>
          Choose your workspace theme. Zen Linen is a calm, minimal linen palette — Solar Dusk is warm amber & stone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="theme-select" className="text-sm font-medium">
            Theme
          </Label>
          <Select value={draft} onValueChange={(v) => setDraft(v as AppTheme)}>
            <SelectTrigger id="theme-select" className="w-full">
              <SelectValue placeholder="Select theme" />
            </SelectTrigger>
            <SelectContent>
              {APP_THEMES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  <div className="flex flex-col text-left">
                    <span className="text-sm font-medium">{t.label}</span>
                    <span className="text-muted-foreground text-xs">{t.description}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            Applies to all UI elements, sidebars, cards, and floating tools. Saved per browser — persists across sessions.
          </p>
        </div>

        {hasChange && (
          <div className="flex items-center gap-2">
            <Button onClick={handleSave} disabled={saving} size="sm" className="gap-2">
              <Save className="size-4" />
              {saving ? "Saving…" : "Save"}
            </Button>
            <span className="text-muted-foreground text-xs">Save to apply {APP_THEMES.find((t) => t.value === draft)?.label} and reload</span>
          </div>
        )}

        {!hasChange && (
          <p className="text-muted-foreground text-xs">Current theme: {APP_THEMES.find((t) => t.value === persistedTheme)?.label}</p>
        )}
      </CardContent>
    </Card>
  );
}
