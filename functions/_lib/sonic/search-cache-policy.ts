import { UPSTREAM_TIMEOUT } from './request-budget';

export function hasSearchTimeout(attempts: unknown): boolean {
  return Array.isArray(attempts) && attempts.some(attempt => attempt?.errorCode === UPSTREAM_TIMEOUT);
}

export function restrictsSearchCaching(cacheControl?: string): boolean {
  return (cacheControl ?? '').split(',').some(directive => {
    const [rawName, value] = directive.trim().toLowerCase().split('=');
    const name = rawName.trim();
    return ['no-store', 'no-cache', 'private'].includes(name) ||
      (['s-maxage', 'max-age'].includes(name) && /^(?:0+|"0+")$/.test(value?.trim() ?? ''));
  });
}
