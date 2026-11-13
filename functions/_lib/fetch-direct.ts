// Workers implements manual redirects, but rejects RequestInit redirect: 'error'.
// Keep credentials and bodies on the original origin in both runtimes.
export async function fetchWithoutRedirect(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, redirect: 'manual' });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Unexpected upstream redirect');
  }
  return response;
}
