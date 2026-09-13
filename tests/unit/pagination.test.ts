import { describe, it, expect } from 'vitest';
import { parsePagination, paginationMeta } from '../../src/utils/pagination';

describe('parsePagination', () => {
  it('falls back to defaults when nothing is supplied', () => {
    expect(parsePagination({})).toEqual({ limit: 30, offset: 0, page: 1 });
  });

  it('honours explicit limit and offset', () => {
    expect(parsePagination({ limit: 10, offset: 40 })).toEqual({ limit: 10, offset: 40, page: 1 });
  });

  it('derives offset from page when offset is absent', () => {
    expect(parsePagination({ limit: 20, page: 3 })).toEqual({ limit: 20, offset: 40, page: 3 });
  });

  it('prefers an explicit offset over the page-derived one', () => {
    expect(parsePagination({ limit: 20, page: 3, offset: 5 }).offset).toBe(5);
  });

  it('clamps limit to maxLimit', () => {
    expect(parsePagination({ limit: 5000 }).limit).toBe(100);
    expect(parsePagination({ limit: 5000 }, { maxLimit: 500 }).limit).toBe(500);
  });

  it('never returns a limit below 1', () => {
    expect(parsePagination({ limit: -20 }).limit).toBe(1);
  });

  it('treats a zero or non-numeric limit as "use the default"', () => {
    expect(parsePagination({ limit: 0 }).limit).toBe(30);
    expect(parsePagination({ limit: 'abc' }).limit).toBe(30);
    expect(parsePagination({ limit: null }).limit).toBe(30);
  });

  it('never returns a negative offset or a page below 1', () => {
    expect(parsePagination({ offset: -10 }).offset).toBe(0);
    expect(parsePagination({ page: -3 }).page).toBe(1);
    expect(parsePagination({ page: 0 }).page).toBe(1);
  });

  it('accepts numeric strings from JSON-RPC clients', () => {
    expect(parsePagination({ limit: '25', offset: '50' })).toEqual({
      limit: 25,
      offset: 50,
      page: 1,
    });
  });

  it('respects a custom default limit', () => {
    expect(parsePagination({}, { limit: 40 }).limit).toBe(40);
  });
});

describe('paginationMeta', () => {
  it('reports hasMore while rows remain', () => {
    expect(paginationMeta(100, 30, 0, 1)).toEqual({
      total: 100,
      limit: 30,
      offset: 0,
      page: 1,
      count: 30,
      hasMore: true,
    });
  });

  it('reports the tail page exactly', () => {
    expect(paginationMeta(100, 30, 90, 4)).toEqual({
      total: 100,
      limit: 30,
      offset: 90,
      page: 4,
      count: 10,
      hasMore: false,
    });
  });

  it('handles an empty result set', () => {
    expect(paginationMeta(0, 30, 0, 1)).toMatchObject({ count: 0, hasMore: false });
  });

  it('handles an offset past the end without going negative', () => {
    expect(paginationMeta(10, 30, 50, 2)).toMatchObject({ count: 0, hasMore: false });
  });

  it('reports hasMore=false when the page ends exactly on the total', () => {
    expect(paginationMeta(60, 30, 30, 2)).toMatchObject({ count: 30, hasMore: false });
  });
});
