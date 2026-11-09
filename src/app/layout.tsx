import type { Metadata } from "next";
import { Instrument_Serif, Plus_Jakarta_Sans } from "next/font/google";
import { AppProviders } from "@/components/providers/Providers";
import { introScript } from "@/components/home/intro";
import { JsonLd } from "@/components/seo/JsonLd";
import {
  HOME_DESCRIPTION,
  HOME_TITLE,
  SITE_NAME,
  SITE_URL,
  organizationJsonLd,
  websiteJsonLd,
} from "@/lib/seo/schema";
import "./globals.css";

/**
 * Two fonts (Open Caption system, adopted 2026-11-09 by owner
 * directive): Plus Jakarta Sans for everything, Instrument Serif
 * Italic as the accent. Hanken Grotesk / Bricolage / IBM Plex Mono
 * were retired here; mono survives only as a system stack token
 * for code/IDs (see globals.css).
 */
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-accent-sys",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

/**
 * Site metadata foundation (SEO pass, 2026-11-10, plan P0/P1):
 * metadataBase + title template + social defaults. The DEFAULT
 * title/description are the HOME page's (the landing is a client
 * component and cannot export metadata, so it inherits these);
 * every other public page overrides with its own template title
 * ("%s | open-autoDM") and description. Canonicals are per-page
 * (alternates.canonical), the social image comes from the
 * opengraph-image.tsx file convention.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: HOME_TITLE, template: "%s | open-autoDM" },
  description: HOME_DESCRIPTION,
  applicationName: SITE_NAME,
  // The home page's self-canonical (it cannot export metadata of
  // its own); every other public page overrides this with its path.
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    locale: "en_IN",
    url: "/",
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Brand intro gate (landing only, once per session): must
            run before first paint — see components/home/intro.ts. */}
        <script dangerouslySetInnerHTML={{ __html: introScript }} />
      </head>
      <body
        className={`${jakarta.variable} ${instrumentSerif.variable} font-sans antialiased bg-background text-foreground transition-colors duration-300`}
      >
        {/* Site-wide structured data (plan P3): Organization +
            WebSite entities on every page. */}
        <JsonLd data={organizationJsonLd()} />
        <JsonLd data={websiteJsonLd()} />
        <AppProviders>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
