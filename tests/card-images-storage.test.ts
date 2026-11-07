/**
 * Phase D2 / Programme 16 — card-image storage helper tests
 * (src/lib/storage/cardImages.ts).
 *
 * Pins both path conventions (legacy user-folder shape from
 * useAutomations.ts and the new workspace shape), the owner-scope
 * parser's refusal to guess ownership from shape alone, and the
 * canWrite role matrix behind assertCardImageWrite. Storage-policy
 * behaviour in SQL is proven separately by the disposable-PostgreSQL
 * rehearsal in saas/phase16-rehearsal/ (migration …000033).
 */
import { describe, it, expect } from 'vitest';
import {
  workspaceCardImagePath,
  userCardImagePath,
  assertCardImageWrite,
  cardImageOwnerScope,
} from '@/lib/storage/cardImages';
import { WorkspaceAccessError, type WorkspaceContext, type WorkspaceRole } from '@/lib/tenancy/context';

const WS = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const NOW = 1730000000000;

const ctx = (role: WorkspaceRole): WorkspaceContext => ({ workspaceId: WS, userId: USER, role });

describe('path shapes', () => {
  it('workspace path is <workspaceId>/<timestamp>-<rand>.<ext>', () => {
    expect(workspaceCardImagePath(WS, 'png', NOW, 'abc123')).toBe(`${WS}/${NOW}-abc123.png`);
    expect(workspaceCardImagePath(WS, 'jpg', NOW, 'x9')).toBe(`${WS}/${NOW}-x9.jpg`);
  });

  it('user path is the legacy useAutomations shape <userId>/<timestamp>-<rand>.<ext>', () => {
    expect(userCardImagePath(USER, 'webp', NOW, 'abc123')).toBe(`${USER}/${NOW}-abc123.webp`);
    // Same construction the legacy inline code performs:
    // `${session.user.id}/${Date.now()}-${Math.random()...}.${ext}`.
    expect(userCardImagePath(USER, 'jpg', NOW, 'abc123')).toBe(
      `${USER}/${NOW}-abc123.jpg`,
    );
  });

  it('both conventions produce the identical shape, differing only in the owner segment', () => {
    const wsPath = workspaceCardImagePath(WS, 'png', NOW, 'r1');
    const userPath = userCardImagePath(USER, 'png', NOW, 'r1');
    expect(wsPath.split('/')[1]).toBe(userPath.split('/')[1]);
    expect(wsPath.split('/')[0]).toBe(WS);
    expect(userPath.split('/')[0]).toBe(USER);
  });

  it('defaults fill timestamp and random suffix; a leading dot on ext is normalized', () => {
    expect(workspaceCardImagePath(WS, '.PNG')).toMatch(
      new RegExp(`^${WS}/\\d+-[a-z0-9]+\\.png$`),
    );
    expect(userCardImagePath(USER, 'jpeg')).toMatch(new RegExp(`^${USER}/\\d+-[a-z0-9]+\\.jpeg$`));
  });
});

describe('cardImageOwnerScope', () => {
  it('classifies a workspace uuid when the workspace hint set contains it', () => {
    expect(cardImageOwnerScope(`${WS}/123-r.png`, { workspaceIds: [WS] })).toEqual({
      kind: 'workspace',
      id: WS,
    });
    expect(
      cardImageOwnerScope(`${WS}/123-r.png`, { workspaceIds: new Set([WS]), userIds: [USER] }),
    ).toEqual({ kind: 'workspace', id: WS });
  });

  it('classifies a user uuid when the user hint set contains it', () => {
    expect(cardImageOwnerScope(`${USER}/123-r.png`, { userIds: [USER] })).toEqual({
      kind: 'user',
      id: USER,
    });
  });

  it('a bare uuid without matching hints is unknown — ownership is never guessed from shape', () => {
    expect(cardImageOwnerScope(`${WS}/123-r.png`)).toEqual({ kind: 'unknown', id: WS });
    expect(cardImageOwnerScope(`${USER}/123-r.png`, { workspaceIds: [WS] })).toEqual({
      kind: 'unknown',
      id: USER,
    });
  });

  it('garbage first segments are unknown', () => {
    expect(cardImageOwnerScope('not-a-uuid/123-r.png')).toEqual({ kind: 'unknown', id: 'not-a-uuid' });
    expect(cardImageOwnerScope('../../etc/passwd')).toEqual({ kind: 'unknown', id: '..' });
  });

  it('empty and segment-less paths report unknown with a null id where there is no segment', () => {
    expect(cardImageOwnerScope('')).toEqual({ kind: 'unknown', id: null });
    expect(cardImageOwnerScope('/123-r.png')).toEqual({ kind: 'unknown', id: null });
  });
});

describe('assertCardImageWrite role matrix', () => {
  it('owner, admin and member may write', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      expect(() => assertCardImageWrite(ctx(role))).not.toThrow();
    }
  });

  it('viewer may not write: throws WorkspaceAccessError insufficient-role', () => {
    try {
      assertCardImageWrite(ctx('viewer'));
      throw new Error('expected assertCardImageWrite to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceAccessError);
      expect((err as WorkspaceAccessError).code).toBe('insufficient-role');
    }
  });
});
