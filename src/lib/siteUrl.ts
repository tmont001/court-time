// Shared production base URL for SEO metadata (metadataBase, sitemap.xml,
// robots.txt). Falls back to the production domain when
// NEXT_PUBLIC_APP_URL isn't set (e.g. local dev). Trailing slash(es)
// stripped so callers can safely concatenate a leading-slash path
// (`${SITE_URL}/features`) without ever producing a double slash —
// NEXT_PUBLIC_APP_URL is documented as "no trailing slash" but isn't
// guaranteed to be entered that way in every environment.
export const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://court-time.app").replace(/\/+$/, "");
