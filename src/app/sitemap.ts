import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/siteUrl";

// Only the six real public marketing pages — deliberately excludes
// /sign-in (a legitimate public entry point per middleware, but not a
// content page worth promoting for search) and every authenticated/
// transactional route, none of which are indexable content.
//
// No lastModified/priority/changeFrequency: this is a small static
// marketing site with no genuine per-page modification dates tracked
// anywhere, and a build-time `new Date()` would falsely claim every page
// changed on every deploy. Add real values back only if a genuine,
// tracked per-page last-modified date becomes available.
const PUBLIC_PATHS = ["", "/features", "/pricing", "/contact", "/privacy", "/terms"];

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PATHS.map((path) => ({
    url: `${SITE_URL}${path}`,
  }));
}
