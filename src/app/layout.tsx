import type { Metadata } from "next";
import { Instrument_Serif, Plus_Jakarta_Sans } from "next/font/google";
import { AppProviders } from "@/components/providers/Providers";
import { introScript } from "@/components/home/intro";
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

export const metadata: Metadata = {
  title: "open-autoDM",
  description:
    "Hosted Instagram comment-to-DM automation with the Creator Studio built in. No per-seat pricing.",
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
        <AppProviders>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
