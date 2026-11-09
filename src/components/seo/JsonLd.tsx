/**
 * JsonLd — renders one schema.org object as an
 * application/ld+json script (SEO pass, 2026-11-10).
 *
 * Deliberately free of server-only APIs so it can render from both
 * server pages (/auto-dm, /pricing) and the client landing page.
 * "<" is escaped so a stray "</script>" can never appear inside
 * the payload.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}
