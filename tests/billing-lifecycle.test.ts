import { describe, it, expect } from 'vitest';
import { ALLOWED_TRANSITIONS, canTransition, grantsEntitlement, isTerminal } from '@/lib/billing/lifecycle';
import { InMemoryBillingEventStore } from '@/lib/billing/events';

describe('billing lifecycle', () => {
  it('allows the documented happy-path transitions', () => {
    expect(canTransition('incomplete', 'trialing')).toBe(true);
    expect(canTransition('incomplete', 'active')).toBe(true);
    expect(canTransition('trialing', 'active')).toBe(true);
    expect(canTransition('active', 'past_due')).toBe(true);
    expect(canTransition('past_due', 'active')).toBe(true);
    expect(canTransition('active', 'paused')).toBe(true);
    expect(canTransition('paused', 'active')).toBe(true);
    expect(canTransition('active', 'cancelled')).toBe(true);
  });
  it('rejects illegal transitions', () => {
    expect(canTransition('cancelled', 'active')).toBe(false);
    expect(canTransition('expired', 'active')).toBe(false);
    expect(canTransition('paused', 'past_due')).toBe(false);
    expect(canTransition('incomplete', 'paused')).toBe(false);
    expect(canTransition('incomplete', 'past_due')).toBe(false);
    expect(canTransition('trialing', 'paused')).toBe(false);
  });
  it('treats cancelled/expired as terminal with no outgoing transitions', () => {
    expect(isTerminal('cancelled')).toBe(true); expect(isTerminal('expired')).toBe(true);
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]); expect(ALLOWED_TRANSITIONS.expired).toEqual([]);
  });
  it('grants entitlement only for active/trialing', () => {
    expect(grantsEntitlement('active')).toBe(true); expect(grantsEntitlement('trialing')).toBe(true);
    for (const s of ['incomplete', 'past_due', 'paused', 'cancelled', 'expired'] as const) expect(grantsEntitlement(s)).toBe(false);
  });
  it('store rejects an illegal transition atomically (state unchanged)', () => {
    const store = new InMemoryBillingEventStore();
    store.ensureSubscription({ providerSubscriptionId: 's1', provider: 'razorpay', workspaceId: null, status: 'cancelled', currency: 'INR', lastEventAt: 1000, version: 3 });
    const r = store.applyTransition('s1', 'active', 2000);
    expect(r.applied).toBe(false); expect(r.reason).toBe('terminal');
    expect(store.getSubscription('s1')!.status).toBe('cancelled'); expect(store.getSubscription('s1')!.version).toBe(3);
  });
  it('store rejects stale (out-of-order) events', () => {
    const store = new InMemoryBillingEventStore();
    store.ensureSubscription({ providerSubscriptionId: 's2', provider: 'razorpay', workspaceId: null, status: 'active', currency: 'INR', lastEventAt: 5000, version: 1 });
    const r = store.applyTransition('s2', 'cancelled', 3000);
    expect(r.applied).toBe(false); expect(r.reason).toBe('stale-event');
    expect(store.getSubscription('s2')!.status).toBe('active');
  });
});
