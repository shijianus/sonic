// G6-4: 20 consecutive mixed-feed requests, latency stats + status codes.
const BASE = 'http://127.0.0.1:3000';
const KEY = 'test_super_secret_engine_key_999_32chars!';
const ANON = 'anon_gray_cold_001';
const N = 20;
const times = [];
const statuses = new Set();
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/sonic/recommend/for-you?feed=mixed&count=12`, {
    headers: { 'X-Sonic-Engine-Key': KEY, 'X-Sonic-Anon-Id': ANON },
  });
  await res.arrayBuffer();
  const dt = performance.now() - t0;
  times.push(dt);
  statuses.add(res.status);
}
times.sort((a, b) => a - b);
const avg = times.reduce((a, b) => a + b, 0) / N;
const p95 = times[Math.min(N - 1, Math.ceil(N * 0.95) - 1)];
console.log(JSON.stringify({
  requests: N,
  statuses: [...statuses],
  avgMs: +avg.toFixed(2),
  minMs: +times[0].toFixed(2),
  maxMs: +times[N - 1].toFixed(2),
  p95Ms: +p95.toFixed(2),
}, null, 1));
