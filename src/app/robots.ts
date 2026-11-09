import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo/schema";

/**
 * robots.txt (SEO pass, 2026-11-10, plan P0-2): the public
 * marketing/legal surface is fully crawlable; the signed-in app
 * surface (console, studio, admin, API, auth) is disallowed.
 * AI-search crawlers are explicitly welcomed, like the competitor
 * does — being citable by AI answers is part of the ranking game.
 * /login stays crawlable but carries a noindex meta (plan P0-5).
 */
export default function robots(): MetadataRoute.Robots {
  const appSurface = [
    "/dashboard",
    "/automations",
    "/analytics",
    "/script-writer",
    "/settings",
    "/setup",
    "/studio",
    "/admin",
    "/api/",
    "/auth/",
    "/billing",
    "/onboarding",
  ];
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: appSurface },
      {
        userAgent: ["GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot"],
        allow: "/",
        disallow: appSurface,
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
