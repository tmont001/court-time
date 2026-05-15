"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs: { label: string; href: string; twoLine?: boolean }[] = [
  { label: "Calendar", href: "/calendar" },
  { label: "Book", href: "/book" },
  { label: "My Schedule", href: "/my-schedule", twoLine: true },
  { label: "Profile", href: "/profile" },
];

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] h-16 border-t border-gray-200 bg-white flex z-40">
      {tabs.map((tab) => {
        const isActive = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex-1 flex flex-col items-center justify-center text-xs font-medium leading-tight ${
              isActive ? "text-gray-900 border-t-2 border-gray-900" : "text-gray-400"
            }`}
          >
            {tab.twoLine ? (
              <>
                <span>My</span>
                <span>Schedule</span>
              </>
            ) : (
              <span>{tab.label}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
