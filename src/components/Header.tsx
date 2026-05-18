import NotificationBell from "@/components/NotificationBell";

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
      <NotificationBell />
    </header>
  );
}
