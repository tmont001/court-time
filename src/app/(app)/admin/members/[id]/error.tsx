"use client";

import Link from "next/link";

export default function MemberDetailError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-48 gap-4 px-6 text-center">
      <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
        Something went wrong loading this member.
      </p>
      <div className="flex items-center gap-4">
        <button
          onClick={reset}
          className="px-4 py-2 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium"
        >
          Try again
        </button>
        <Link
          href="/admin/members"
          className="text-sm font-medium text-gray-500 dark:text-gray-400 hover:underline"
        >
          ← Back to Members
        </Link>
      </div>
    </div>
  );
}
