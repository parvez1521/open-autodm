'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSharedSession } from '@/lib/api/client';

/**
 * "Save contacts" toggle (owner request, 2026-11-27): whether people who
 * trigger an automation are saved as contacts. One per-user setting
 * (profiles.save_contacts, DEFAULT true) read/written through
 * /api/contacts/settings. Same authenticated-fetch pattern as the
 * ContactsList CSV export (Bearer token from the shared session).
 * The mutation updates optimistically and rolls back on failure, so a
 * failed save never leaves the switch showing the wrong state.
 */

async function fetchSettings(): Promise<boolean> {
  const session = await getSharedSession();
  const headers = new Headers();
  if (session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`);
  const res = await fetch('/api/contacts/settings', { headers });
  if (!res.ok) throw new Error(`Could not load the setting (${res.status})`);
  const body = (await res.json()) as { saveContacts?: unknown };
  return body.saveContacts !== false;
}

async function saveSettings(saveContacts: boolean): Promise<boolean> {
  const session = await getSharedSession();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`);
  const res = await fetch('/api/contacts/settings', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ saveContacts }),
  });
  if (!res.ok) throw new Error(`Could not save the setting (${res.status})`);
  const body = (await res.json()) as { saveContacts?: unknown };
  return body.saveContacts !== false;
}

export function useContactSettings() {
  return useQuery({
    queryKey: ['contact-settings'],
    queryFn: fetchSettings,
    staleTime: 60 * 1000,
  });
}

export function useSaveContactSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveSettings,
    onMutate: async (next: boolean) => {
      await queryClient.cancelQueries({ queryKey: ['contact-settings'] });
      const previous = queryClient.getQueryData<boolean>(['contact-settings']);
      queryClient.setQueryData(['contact-settings'], next);
      return { previous };
    },
    onError: (_err, _next, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(['contact-settings'], context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['contact-settings'] });
    },
  });
}
