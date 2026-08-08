import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/siteUrl";

// Explicit allow-list of the real public marketing/entry surface, plus an
// explicit disallow-list of the authenticated app and transactional auth
// flows — belt-and-suspenders alongside the (app)/(auth) layouts' own
// `robots: { index: false }` metadata and the middleware's actual access
// control (this file only affects crawling, not who can load a URL).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/features", "/pricing", "/contact", "/privacy", "/terms", "/sign-in"],
      disallow: [
        "/calendar",
        "/events",
        "/my-schedule",
        "/profile",
        "/admin",
        "/book",
        "/lessons",
        "/help",
        "/sign-up",
        "/forgot-password",
        "/reset-password",
        "/welcome",
        "/pending-invite",
        "/join",
        "/auth",
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
