/**
 * Keep pagination state bounded even when an upstream total changes between
 * requests.  Search endpoints are allowed to return malformed totals, so all
 * values are normalized before they reach the UI or trigger another request.
 */
export function normalizePaginationTotal(value: unknown, fallback = 0): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return Math.max(0, Math.floor(fallback))
  return Math.floor(numeric)
}

export function getTotalPages(total: unknown, pageSize: unknown): number {
  const normalizedTotal = normalizePaginationTotal(total)
  const normalizedPageSize = normalizePaginationTotal(pageSize, 1)
  return Math.max(1, Math.ceil(normalizedTotal / Math.max(1, normalizedPageSize)))
}

// Unknown catalogue totals support sequential navigation. This upper bound is
// used for the controls only and is never displayed as a result count.
export function unknownSearchNavigationTotal(page: number, size: number, length: number, hasMore?: boolean): number {
  return (page - 1) * size + Math.max(1, (hasMore ?? length >= size) ? size + 1 : Math.min(length, size))
}

export function clampPage(page: unknown, total: unknown, pageSize: unknown): number {
  const numericPage = typeof page === 'number' ? page : Number(page)
  const safePage = Number.isFinite(numericPage) ? Math.floor(numericPage) : 1
  return Math.min(Math.max(1, safePage), getTotalPages(total, pageSize))
}
