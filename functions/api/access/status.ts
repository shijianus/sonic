// GET /api/access/status — documented alias of /api/access/session (audit P2-12).
// `requireAccess` has always listed this path as public, but no Pages route
// existed, so clients hit a 404 SPA fallback. Serve the same contract.
export { onRequest } from './session';
