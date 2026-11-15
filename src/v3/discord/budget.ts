/** Counts the SQL statements a unit of work prepares (a conservative D1 query count: a batch of n counts n). Used by the drain to stay under the free-plan limit. */
export interface Counted<T> { db: T; readonly queries: number }

export function countingDb(db: D1Database): Counted<D1Database> {
  let n = 0;
  const proxy = new Proxy(db, {
    get(target, prop) {
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (prop === "prepare") { const prep = target.prepare.bind(target); return (sql: string) => { n++; return prep(sql); }; }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { db: proxy, get queries() { return n; } };
}
