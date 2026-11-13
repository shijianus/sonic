import { DurableObject } from 'cloudflare:workers';

const windowMs = 60_000;
const counterKey = 'window-v1';

export class SonicRateBucket extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || path !== '/v1/consume') return new Response(null, { status: 404 });
    const limit = Number(request.headers.get('x-sonic-bucket-limit'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 20_000) return new Response(null, { status: 400 });

    const storage = this.ctx.storage;
    const now = Date.now();
    // No await between the read and write. SQLite commits before the response leaves the object.
    const previous = storage.kv.get(counterKey);
    const expired = !previous || previous.resetAt <= now;
    const resetAt = expired ? now + windowMs : previous.resetAt;
    const count = expired ? 0 : previous.count;
    const allowed = count < limit;
    if (allowed) storage.kv.put(counterKey, { count: count + 1, resetAt });
    if (expired) await storage.setAlarm(resetAt);
    return Response.json({
      allowed,
      remaining: Math.max(0, limit - count - Number(allowed)),
      resetSec: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    });
  }

  async alarm() {
    const storage = this.ctx.storage;
    const window = storage.kv.get(counterKey);
    if (window && window.resetAt > Date.now()) {
      await storage.setAlarm(window.resetAt);
      return;
    }
    await storage.deleteAll();
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
