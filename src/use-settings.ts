import { useCallback, useEffect, useRef, useState } from "react";
import { AppSettings, defaultSettings } from "./types";
import { SETTINGS_KEY, loadSettings, normalizeSettings, saveSettings } from "./storage";

/** Single owner of the settings lifecycle: hydration guard, live sync and debounced save. */
export function useSettings(saveDelay = 400) {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [saved, setSaved] = useState(false);
  const hydrated = useRef(false);
  const dirty = useRef(false);

  useEffect(() => { void loadSettings().then((value) => { hydrated.current = true; setSettings(value); }); }, []);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local" || !changes[SETTINGS_KEY] || dirty.current) return;
      hydrated.current = true;
      setSettings(normalizeSettings(changes[SETTINGS_KEY].newValue as Partial<AppSettings> | undefined));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  useEffect(() => {
    if (!hydrated.current || !dirty.current) return;
    const timer = setTimeout(() => {
      void saveSettings(settings).then(() => {
        dirty.current = false;
        setSaved(true);
        setTimeout(() => setSaved(false), 1200);
      });
    }, saveDelay);
    return () => clearTimeout(timer);
  }, [settings, saveDelay]);

  const update = useCallback((patch: Partial<AppSettings> | ((current: AppSettings) => Partial<AppSettings>)) => {
    setSettings((current) => {
      dirty.current = true;
      return { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
    });
  }, []);

  return { settings, update, saved, hydrated };
}

export function useTheme(settings: AppSettings) {
  useEffect(() => {
    const dark = settings.theme === "dark" || (settings.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    if (settings.brand.accentColor) document.documentElement.style.setProperty("--signal", settings.brand.accentColor);
    else document.documentElement.style.removeProperty("--signal");
  }, [settings.theme, settings.brand.accentColor]);
}
