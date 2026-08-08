import type { Metadata } from "next";

// Sign-in/sign-up/password-reset/invite-acceptance are transactional utility
// pages tied to a specific link or flow, not marketing content — none of
// them belong in search results.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
