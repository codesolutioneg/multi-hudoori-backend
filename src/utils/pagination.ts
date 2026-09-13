export function parsePagination(
  params: Record<string, unknown>,
  defaults: { limit?: number; maxLimit?: number } = {},
) {
  const maxLimit = defaults.maxLimit ?? 100;
  const defaultLimit = defaults.limit ?? 30;
  const limit = Math.min(maxLimit, Math.max(1, Number(params.limit ?? defaultLimit) || defaultLimit));
  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const offsetParam = Number(params.offset);
  const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : (page - 1) * limit;
  return { limit, offset, page };
}

export function paginationMeta(total: number, limit: number, offset: number, page: number) {
  const returned = Math.min(limit, Math.max(0, total - offset));
  return {
    total,
    limit,
    offset,
    page,
    count: returned,
    hasMore: offset + returned < total,
  };
}
