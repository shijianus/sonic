export function hasPersonalizationOptOut(request: Request): boolean {
  const url = new URL(request.url);
  return [
    request.headers.get('x-sonic-personalization'),
    ...url.searchParams.getAll('personalize'),
    ...url.searchParams.getAll('personalization'),
  ].some(value => ['off', '0', 'false'].includes(String(value || '').trim().toLowerCase()));
}
