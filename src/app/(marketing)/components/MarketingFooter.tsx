import Link from "next/link";

export default function MarketingFooter() {
  return (
    <footer className="border-t border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">
      <div className="max-w-5xl mx-auto px-4 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">

        <p className="text-xs text-gray-400 dark:text-gray-500">
          © {new Date().getFullYear()} Court Time. All rights reserved.
        </p>

        <nav className="flex items-center gap-5 flex-wrap justify-center">
          <Link
            href="/features"
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 motion-safe:transition-colors motion-safe:duration-150"
          >
            Features
          </Link>
          <Link
            href="/pricing"
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 motion-safe:transition-colors motion-safe:duration-150"
          >
            Pricing
          </Link>
          <Link
            href="/terms"
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 motion-safe:transition-colors motion-safe:duration-150"
          >
            Terms
          </Link>
          <Link
            href="/privacy"
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 motion-safe:transition-colors motion-safe:duration-150"
          >
            Privacy
          </Link>
          <Link
            href="/contact"
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 motion-safe:transition-colors motion-safe:duration-150"
          >
            Request a Pilot
          </Link>
          <Link
            href="/sign-in"
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 motion-safe:transition-colors motion-safe:duration-150"
          >
            Sign in
          </Link>
        </nav>

      </div>
    </footer>
  );
}
