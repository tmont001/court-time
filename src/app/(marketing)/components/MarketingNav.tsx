import Link from "next/link";

export default function MarketingNav() {
  return (
    <header className="sticky top-0 z-30 bg-white/90 dark:bg-gray-900/90 backdrop-blur border-b border-gray-100 dark:border-gray-800">
      <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between gap-6">

        {/* Wordmark */}
        <Link
          href="/"
          className="text-sm font-semibold text-gray-900 dark:text-gray-100 tracking-tight hover:text-accent motion-safe:transition-colors motion-safe:duration-150"
        >
          Court Time
        </Link>

        {/* Nav links — visible on sm+ */}
        <nav className="hidden sm:flex items-center gap-6">
          <Link
            href="/pricing"
            className="text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors motion-safe:duration-150"
          >
            Pricing
          </Link>
          <Link
            href="/contact"
            className="text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors motion-safe:duration-150"
          >
            Contact
          </Link>
        </nav>

        {/* Right: mobile Contact + Sign in */}
        <div className="flex items-center gap-3">
          <Link
            href="/contact"
            className="sm:hidden text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors motion-safe:duration-150"
          >
            Contact
          </Link>
          <Link
            href="/sign-in"
            className="text-sm font-medium text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 px-3 py-1.5 rounded-lg hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
          >
            Sign in
          </Link>
        </div>

      </div>
    </header>
  );
}
