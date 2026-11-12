export async function withProviderFixtures(respond, run) {
  const originalFetch = globalThis.fetch;
  const unexpected = new Set();

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const requestName = `${init.method ?? (input instanceof Request ? input.method : 'GET')} ${url.origin}${url.pathname}`;
    let response;
    try {
      response = await respond(url, init);
    } catch (error) {
      if (!init.signal?.aborted || error !== init.signal.reason) unexpected.add(`${requestName} (${error.message})`);
      throw error;
    }
    if (response instanceof Response) return response;

    // The gateway may swallow upstream errors and return a fallback. Report
    // missing fixtures after the suite so a fallback cannot hide a new route.
    unexpected.add(requestName);
    throw new Error(`No provider fixture for ${requestName}`);
  };

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (unexpected.size) throw new Error(`Unexpected provider requests:\n${[...unexpected].join('\n')}`);
  }
}
