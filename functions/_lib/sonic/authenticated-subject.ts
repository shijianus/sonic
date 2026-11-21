import type { AppEnv } from '../types';
import { verifyAuth } from '../auth';
import { AccountError } from '../account/library';
import { sha256Hex } from './crypto';
import { requireValidEngineIdentity, verifyEngineAccountSubject } from './engine-identity';

/** Account identity only: never consults device IDs, invitation IDs, context hints or consent. */
export async function resolveAuthenticatedSubject(request: Request, env?: AppEnv, checkLibraryTarget = false): Promise<string | null> {
  const assertion = await requireValidEngineIdentity(request, env);
  if (assertion) return verifyEngineAccountSubject(request, env);
  if (!env) return null;
  const auth = await verifyAuth(request, env);
  if (!auth.authenticated || !auth.user?.email) return null;
  if (checkLibraryTarget) {
    const target = request.headers.get('X-Sonic-Account-Target');
    if ((target !== null || auth.source === 'cookie') && target !== auth.user.id) {
      throw new AccountError('ACCOUNT_IDENTITY_MISMATCH', 'Refresh your account before accessing this library', 409);
    }
  }
  // Same stable, non-PII namespace as existing verified sessions; not the invitation/user ID.
  return `usr_${sha256Hex(`sonic-subj-v1:usr:${auth.user.email.toLowerCase()}`).slice(0, 24)}`;
}
