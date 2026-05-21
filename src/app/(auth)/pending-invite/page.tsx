export const dynamic = "force-dynamic";

export default function PendingInvitePage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-3">
        Almost there
      </h1>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
        Your account is ready, but you haven&apos;t joined a club yet.
      </p>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Use the invite link your club admin sent you to get started.
      </p>
    </div>
  );
}
