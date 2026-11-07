import { StudioNav } from "@/components/studio/StudioNav";

/**
 * Creator Studio section layout (Programme S1). Lives inside the (main)
 * app shell — same sidebar, topbar and auth as the rest of the app.
 */
export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Creator Studio</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Plan, write and package your next video — niche to publish — with built-in
          tools that work offline and free AI where it is configured.
        </p>
      </div>
      <StudioNav />
      {children}
    </div>
  );
}
