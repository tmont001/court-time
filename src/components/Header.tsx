interface HeaderProps {
  screenTitle: string;
}

export default function Header({ screenTitle }: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-4 h-14 border-b border-gray-200 bg-white">
      <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">
        Riverside Tennis Club
      </span>
      <span className="text-sm font-semibold text-gray-900">{screenTitle}</span>
      {/* Bell placeholder — non-functional in Phase 1 */}
      <button
        aria-label="Notifications"
        className="w-8 h-8 flex items-center justify-center text-gray-400"
        disabled
      >
        &#9679;
      </button>
    </header>
  );
}
