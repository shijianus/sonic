import type { AppEnv } from '../types';
import { verifyAuth } from '../auth';
import { sha256Hex } from './crypto';
import { requireValidEngineIdentity, verifyEngineAccountSubject } from './engine-identity';

/** Account identity only: never consults device IDs, invitation IDs, context hints or consent. */
export async function resolveAuthenticatedSubject(request: Request, env?: AppEnv): Promise<string | null> {
  const assertion = await requireValidEngineIdentity(request, env);
  if (assertion) return verifyEngineAccountSubject(request, env);
  if (!env) return null;
  const auth = await verifyAuth(request, env);
  if (!auth.authenticated || !auth.user?.email) return null;
  // Same stable, non-PII namespace as existing verified sessions; not the invitation/user ID.
  return `usr_${sha256Hex(`sonic-subj-v1:usr:${auth.user.email.toLowerCase()}`).slice(0, 24)}`;
}
