// Shared "app chrome" shell for marketing product illustrations. Purely
// decorative — the substantive product claims live in the surrounding page
// copy, so every consumer is expected to render this inside an
// aria-hidden="true" wrapper (or use it directly, since it sets
// aria-hidden on its own root) rather than exposing it to screen readers.
export default function ProductFrame({
  label,
  sublabel,
  padded = true,
  children,
}: {
  label: string;
  sublabel?: string;
  /** Set false for content (e.g. the calendar grid) that should run edge-to-edge, matching the real app's chromeless surfaces. */
  padded?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      aria-hidden="true"
      className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl overflow-hidden"
    >
      <div className="bg-gray-50 dark:bg-gray-700/60 border-b border-gray-100 dark:border-gray-700 px-4 py-2.5 flex items-center justify-between gap-3">
        <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 truncate">
          {label}
        </span>
        {sublabel && (
          <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500">
            {sublabel}
          </span>
        )}
      </div>
      <div className={padded ? "p-4" : ""}>{children}</div>
    </div>
  );
}
