// In-memory token bucket (backend spec §10.1). One web process, so memory is enough for v1;
// the Postgres move replaces this with a shared store.

export type Limit = { capacity: number; perMs: number };

export const LIMITS = {
  intake: { capacity: 120, perMs: 60_000 },
  login: { capacity: 10, perMs: 60_000 },
  default: { capacity: 600, perMs: 60_000 },
} satisfies Record<string, Limit>;

type Bucket = { tokens: number; updatedAt: number };

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Take one token. Returns false when the bucket is empty. */
  take(key: string, limit: Limit): boolean {
    const t = this.now();
    const refillPerMs = limit.capacity / limit.perMs;
    const b = this.buckets.get(key) ?? { tokens: limit.capacity, updatedAt: t };
    b.tokens = Math.min(limit.capacity, b.tokens + (t - b.updatedAt) * refillPerMs);
    b.updatedAt = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 50_000) this.prune(t, limit);
    return ok;
  }

  private prune(t: number, limit: Limit) {
    for (const [k, b] of this.buckets) if (t - b.updatedAt > limit.perMs) this.buckets.delete(k);
  }
}

const globalForLimiter = globalThis as unknown as { rateLimiter?: RateLimiter };
export const rateLimiter = (globalForLimiter.rateLimiter ??= new RateLimiter());

export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "local";
}
