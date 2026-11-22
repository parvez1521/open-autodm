import { ContactsList } from "@/components/automations/ContactsList";

/**
 * Contacts (audit fix, 2026-11-22): /contacts used to 404 and the
 * sidebar had no Contacts entry, even though the dashboard reports
 * the captured audience — contacts only existed as a tab on
 * /automations. This route renders the SAME ContactsList (search,
 * export, Leads tab included), so there is one contacts UI, not a
 * second copy; the /automations tab keeps rendering it too.
 */
export default function ContactsPage() {
    return (
        <div className="w-full max-w-5xl mx-auto space-y-6 pb-16">
            <div>
                <h1 className="text-xl font-heading font-semibold tracking-tight text-foreground">Contacts</h1>
                <p className="text-[13px] text-muted-foreground mt-1">
                    Every audience member your automations have captured.
                </p>
            </div>
            <ContactsList />
        </div>
    );
}
