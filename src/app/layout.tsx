import type { Metadata } from "next";
import { Hanken_Grotesk, Bricolage_Grotesque, IBM_Plex_Mono } from "next/font/google";
import { AppProviders } from "@/components/providers/Providers";
import "./globals.css";

const hanken = Hanken_Grotesk({
  variable: "--font-hanken",
  subsets: ["latin"],
});

const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "open-autoDM",
  description:
    "Open-source, self-hosted Instagram comment-to-DM automation. Your own Meta app, your own Supabase, your own deployment.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${hanken.variable} ${bricolage.variable} ${plexMono.variable} font-sans antialiased bg-background text-foreground transition-colors duration-300`}
      >
        <AppProviders>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
