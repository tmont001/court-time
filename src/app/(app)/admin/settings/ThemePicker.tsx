"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateClubTheme } from "./actions";

const THEMES = [
  { key: "graphite",   label: "Graphite",    lightAccent: "#374151" },
  { key: "cobalt",     label: "Cobalt",      lightAccent: "#1d4ed8" },
  { key: "teal",       label: "Teal",        lightAccent: "#0d9488" },
  { key: "sage",       label: "Sage",        lightAccent: "#4d7c5a" },
  { key: "plum",       label: "Plum",        lightAccent: "#6b21a8" },
  { key: "rose",       label: "Rose",        lightAccent: "#e11d48" },
  { key: "terracotta", label: "Terracotta",  lightAccent: "#c2410c" },
  { key: "gold",       label: "Gold",        lightAccent: "#b45309" },
] as const;

type ThemeKey = typeof THEMES[number]["key"];

interface Props {
  currentTheme: string;
}

export default function ThemePicker({ currentTheme }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<string>(currentTheme);
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  function handleSelect(key: ThemeKey) {
    if (key === selected || isPending) return;
    const prev = selected;
    setSelected(key);
    setStatus(null);
    startTransition(async () => {
      const result = await updateClubTheme(key);
      if (result.error) {
        setSelected(prev);
        setStatus({ type: "error", message: result.error });
      } else {
        setStatus({ type: "success", message: "Theme saved." });
        setTimeout(() => setStatus(null), 2500);
        router.refresh(); // re-renders the app layout with the new theme class
      }
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-4 flex-wrap">
        {THEMES.map((theme) => {
          const isSelected = selected === theme.key;
          return (
            <button
              key={theme.key}
              type="button"
              onClick={() => handleSelect(theme.key)}
              disabled={isPending}
              className="flex flex-col items-center gap-1 disabled:opacity-60"
            >
              <div
                className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
                  isSelected
                    ? "ring-2 ring-offset-2 ring-gray-400 dark:ring-gray-500 scale-110"
                    : "opacity-70 hover:opacity-100"
                }`}
                style={{ backgroundColor: theme.lightAccent }}
              >
                {isSelected && (
                  <svg
                    width="18" height="18" viewBox="0 0 24 24"
                    fill="none" stroke="white" strokeWidth="3"
                    strokeLinecap="round" strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>
              <span className="text-[10px] font-medium text-gray-500 dark:text-gray-400">
                {theme.label}
              </span>
            </button>
          );
        })}
      </div>
      {status && (
        <p className={`text-xs font-medium ${
          status.type === "success"
            ? "text-green-600 dark:text-green-400"
            : "text-red-500 dark:text-red-400"
        }`}>
          {status.message}
        </p>
      )}
    </div>
  );
}
