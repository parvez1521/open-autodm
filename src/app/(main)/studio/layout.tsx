import { StudioNav } from "@/components/studio/StudioNav";

/**
 * Creator Studio section layout (Programme S1; two-column shell from
 * the Studio restructure). Lives inside the (main) app shell — same
 * sidebar, topbar and auth as the rest of the app.
 *
 * A slim Studio header band sits above a two-column area: the grouped
 * Studio navigation in a sticky left rail on large screens (stacked
 * above the content as a compact scrolling row on smaller screens),
 * and the tool page itself in the flexible content column.
 */
export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-7xl">
      <div className="mb-6 border-b border-border pb-5">
        <h1 className="text-xl font-semibold tracking-tight">Creator Studio</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Plan, write and package your next video, from niche to publish, with built-in
          tools that work offline and free AI where it is configured.
        </p>
      </div>
      <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
        <aside className="w-full shrink-0 lg:sticky lg:top-6 lg:w-60 lg:self-start">
          <StudioNav />
        </aside>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
