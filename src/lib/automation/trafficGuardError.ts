/**
 * Thrown when an account or automation is paused by Smart Comment Traffic
 * Guard. The queue engine turns this into a HELD job (status 'held') — the
 * job is neither failed nor dropped, and the Traffic Guard resume RPC moves
 * held jobs back to 'pending'.
 *
 * Lives in its own module (release-prep defined it inside processJob.ts) so
 * the engine can import it without a cycle, and so unit tests that mock
 * processJob/queue still resolve the real class.
 */
export class AccountOnTrafficGuardPause extends Error {
  constructor(
    public readonly accountId: string,
    public readonly automationId?: string
  ) {
    super(`Account ${accountId} is paused by Smart Comment Traffic Guard`);
    this.name = 'AccountOnTrafficGuardPause';
  }
}
