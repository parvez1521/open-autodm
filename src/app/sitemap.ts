import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo/schema";

/**
 * sitemap.xml (SEO pass, 2026-11-10, plan P0-3): the public,
 * indexable routes only — home, the /auto-dm keyword landing page,
 * pricing, get-started and the legal pages. Console/auth routes
 * are excluded (and disallowed in robots.ts besides). Use-case
 * child pages join this list as they ship (phase 2).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const entry = (
    path: string,
    priority: number,
    changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"],
  ) => ({
    url: `${SITE_URL}${path}`,
    lastModified,
    changeFrequency,
    priority,
  });
  return [
    entry("/", 1.0, "weekly"),
    entry("/auto-dm", 0.9, "weekly"),
    entry("/pricing", 0.8, "weekly"),
    entry("/get-started", 0.7, "monthly"),
    entry("/privacy-policy", 0.3, "yearly"),
    entry("/terms", 0.3, "yearly"),
    entry("/data-deletion", 0.3, "yearly"),
  ];
}
