const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escapes a value for interpolation into an HTML attribute or text node built via innerHTML.
 * Cover URLs originate from third-party provider metadata and are untrusted.
 */
export function escapeHtmlAttribute(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch])
}
