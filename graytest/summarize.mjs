// Gray-test evidence summarizer: reads full JSON response from stdin, prints compact evidence line.
// Usage: node graytest/summarize.mjs [maxItems]
const maxItems = Number(process.argv[2] || 14);
let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
let j;
try {
  j = JSON.parse(raw);
} catch {
  console.log('NON_JSON_RESPONSE:', raw.slice(0, 300));
  process.exit(0);
}
const d = j.data || {};
const items = d.tracks || d.items || d.list || [];
const seq = items.slice(0, maxItems).map((t, i) => {
  const type = t.type || 'track';
  return `${i + 1}.${type}:${(t.title || t.name || t.id || '?')}@${t.artist || t.creator || ''}${t.album ? `{alb:${t.album}}` : ''}`;
});
console.log('HTTP_BODY_SUMMARY');
console.log(' mode:', d.mode, '| personalized:', d.personalized, '| privacyMode:', d.privacyMode, '| storage:', d.storageKind);
if (d.distribution || d.meta?.distribution) console.log(' distribution:', JSON.stringify(d.distribution || d.meta.distribution));
console.log(' itemCount:', items.length, '| topTypeSeq:', items.slice(0, maxItems).map((t) => t.type || 'track').join(','));
console.log(' seq:', seq.join(' | '));
const m = j.meta || {};
console.log(' meta:', JSON.stringify({ latencyMs: m.latencyMs, via: m.via, degraded: m.degraded, degradedReason: m.degradedReason, provider: m.provider, cached: m.cached }));
if (j.error) console.log(' ERROR:', JSON.stringify(j.error));
