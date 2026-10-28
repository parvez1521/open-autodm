import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as getStatus } from './status/route';
import { POST as pauseRoute } from './pause/route';
import { POST as resumeRoute } from './resume/route';
import { POST as dismissRoute } from './dismiss/route';

// Mocks
const mockGetAuthenticatedUser = vi.fn();
const mockFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: (req: Request) => mockGetAuthenticatedUser(req),
  unauthorized: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockFrom,
    rpc: mockRpc,
  }),
}));

vi.mock('@/lib/debugLog', () => ({
  debugLog: vi.fn(),
}));

describe('Traffic Guard API Routes — Security & Owner Isolation', () => {
  beforeEach(() => {
    mockGetAuthenticatedUser.mockReset();
    mockFrom.mockReset();
    mockRpc.mockReset();
  });

  describe('GET /api/traffic-guard/status', () => {
    it('rejects unauthenticated requests with 401', async () => {
      mockGetAuthenticatedUser.mockResolvedValueOnce(null);
      const req = new Request('http://localhost/api/traffic-guard/status?accountId=00000000-0000-0000-0000-000000000001');
      const res = await getStatus(req);
      expect(res.status).toBe(401);
    });

    it('rejects requests for another user account with 403', async () => {
      mockGetAuthenticatedUser.mockResolvedValueOnce({ id: 'user_A' });
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'acc_1', user_id: 'user_B' }, // Belongs to user_B!
          error: null,
        }),
      });

      const req = new Request('http://localhost/api/traffic-guard/status?accountId=00000000-0000-0000-0000-000000000001');
      const res = await getStatus(req);
      expect(res.status).toBe(403);
    });

    it('returns status for authorized owner with 200', async () => {
      mockGetAuthenticatedUser.mockResolvedValueOnce({ id: 'user_A' });
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'acc_1', user_id: 'user_A' },
          error: null,
        }),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [] }),
      });

      mockRpc.mockResolvedValueOnce({
        data: {
          account_id: 'acc_1',
          traffic_status: 'normal',
          is_paused: false,
          current_60s_count: 5,
        },
        error: null,
      });

      const req = new Request('http://localhost/api/traffic-guard/status?accountId=00000000-0000-0000-0000-000000000001');
      const res = await getStatus(req);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.traffic_status).toBe('normal');
    });
  });

  describe('POST /api/traffic-guard/pause', () => {
    it('rejects unauthenticated pause request with 401', async () => {
      mockGetAuthenticatedUser.mockResolvedValueOnce(null);
      const req = new Request('http://localhost/api/traffic-guard/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: '00000000-0000-0000-0000-000000000001',
          incidentId: '00000000-0000-0000-0000-000000000002',
        }),
      });
      const res = await pauseRoute(req);
      expect(res.status).toBe(401);
    });

    it('rejects non-owner pause request with 403', async () => {
      mockGetAuthenticatedUser.mockResolvedValueOnce({ id: 'user_attacker' });
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'acc_1', user_id: 'user_victim' },
          error: null,
        }),
      });

      const req = new Request('http://localhost/api/traffic-guard/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: '00000000-0000-0000-0000-000000000001',
          incidentId: '00000000-0000-0000-0000-000000000002',
        }),
      });
      const res = await pauseRoute(req);
      expect(res.status).toBe(403);
    });

    it('rejects an incident that does not belong to the account without invoking the pause RPC', async () => {
      mockGetAuthenticatedUser.mockResolvedValueOnce({ id: 'user_owner' });
      mockFrom
        .mockReturnValueOnce({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { id: 'acc_1', user_id: 'user_owner' },
            error: null,
          }),
        })
        .mockReturnValueOnce({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'No incident for this account' },
          }),
        });

      const req = new Request('http://localhost/api/traffic-guard/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: '00000000-0000-0000-0000-000000000001',
          incidentId: '00000000-0000-0000-0000-000000000002',
        }),
      });
      const res = await pauseRoute(req);
      expect(res.status).toBe(404);
      expect(mockFrom).toHaveBeenNthCalledWith(2, 'comment_traffic_incidents');
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('allows owner to pause automations with 200', async () => {
      mockGetAuthenticatedUser.mockResolvedValueOnce({ id: 'user_owner' });
      mockFrom
        .mockReturnValueOnce({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { id: 'acc_1', user_id: 'user_owner' },
            error: null,
          }),
        })
        .mockReturnValueOnce({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { id: 'incident_1' },
            error: null,
          }),
        });

      mockRpc.mockResolvedValueOnce({
        data: {
          success: true,
          paused_automation_ids: ['00000000-0000-0000-0000-000000000003'],
          held_jobs_count: 2,
        },
        error: null,
      });

      const req = new Request('http://localhost/api/traffic-guard/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: '00000000-0000-0000-0000-000000000001',
          incidentId: '00000000-0000-0000-0000-000000000002',
        }),
      });
      const res = await pauseRoute(req);
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(json.pausedAutomationIds).toHaveLength(1);
    });
  });

  describe('POST /api/traffic-guard/resume', () => {
    it('allows owner to resume automations with 200', async () => {
      mockGetAuthenticatedUser.mockResolvedValueOnce({ id: 'user_owner' });
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'acc_1', user_id: 'user_owner' },
          error: null,
        }),
      });

      mockRpc.mockResolvedValueOnce({
        data: {
          success: true,
          resumed_automation_ids: ['00000000-0000-0000-0000-000000000003'],
          resumed_jobs_count: 2,
        },
        error: null,
      });

      const req = new Request('http://localhost/api/traffic-guard/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: '00000000-0000-0000-0000-000000000001',
          incidentId: '00000000-0000-0000-0000-000000000002',
        }),
      });
      const res = await resumeRoute(req);
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(json.resumedAutomationIds).toHaveLength(1);
    });
  });

  describe('POST /api/traffic-guard/dismiss', () => {
    it('allows owner to dismiss notification with 200', async () => {
      mockGetAuthenticatedUser.mockResolvedValueOnce({ id: 'user_owner' });
      const mockUpdate = vi.fn().mockReturnThis();
      const mockEq1 = vi.fn().mockReturnThis();
      const mockEq2 = vi.fn().mockResolvedValue({ error: null });

      mockFrom.mockReturnValue({
        update: mockUpdate,
      });
      mockUpdate.mockReturnValue({ eq: mockEq1 });
      mockEq1.mockReturnValue({ eq: mockEq2 });

      const req = new Request('http://localhost/api/traffic-guard/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notificationId: '00000000-0000-0000-0000-000000000009',
        }),
      });
      const res = await dismissRoute(req);
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
    });
  });
});
