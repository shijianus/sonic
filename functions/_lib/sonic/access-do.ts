import type { AppEnv } from '../types';
import type { AccessRepository, AccessSessionRecord } from './access';

export function createDurableAccessRepository(binding: NonNullable<AppEnv['SONIC_ACCESS_BUCKETS']>): AccessRepository {
  async function call(path: string, payload?: object): Promise<Response> {
    const response = await binding.getByName('access-v1').fetch(`https://sonic-access.internal/v1/${path}`, {
      method: payload ? 'POST' : 'GET',
      ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(1500),
    });
    if (response.headers.get('X-Sonic-Access-Store') !== 'v1') {
      await response.body?.cancel();
      throw new Error('Durable access store unavailable');
    }
    return response;
  }

  return {
    async redeemInviteAndCreateSession(codeHash, record) {
      const response = await call('redeem', { codeHash, ...record });
      if (response.status === 409) return null;
      if (response.status !== 201) throw new Error('Durable invite redemption unavailable');
      return { inviteId: codeHash };
    },
    async getSession(sessionHash) {
      const response = await call('session', { sessionHash });
      if (response.status === 404) return null;
      if (response.status !== 200) throw new Error('Durable access store unavailable');
      const record = await response.json() as AccessSessionRecord;
      if (record?.sessionHash !== sessionHash || !Number.isSafeInteger(record.createdAt) ||
          !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.createdAt) {
        throw new Error('Invalid durable access session response');
      }
      return record;
    },
    async revokeSession(sessionHash) {
      if ((await call('revoke', { sessionHash })).status !== 204) throw new Error('Durable access revocation unavailable');
    },
    async checkReady() {
      if ((await call('health')).status !== 204) throw new Error('Durable access store unavailable');
    },
  };
}
