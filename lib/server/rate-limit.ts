import { Redis } from "@upstash/redis";
import { StoreError } from "./signaling-store";

const globalState = globalThis as typeof globalThis & { __abrRateLimits?: Map<string, { count: number; reset: number }> };
globalState.__abrRateLimits ??= new Map();
const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN ? Redis.fromEnv() : null;

export async function enforceRateLimit(request: Request, scope: string, maximum: number, windowSeconds = 60) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const identity = forwarded || request.headers.get("x-real-ip") || "local";
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `abr:rate:${scope}:${identity}:${bucket}`;
  let count: number;
  if (redis) {
    count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds + 2);
  } else {
    const previous = globalState.__abrRateLimits!.get(key);
    count = (previous?.count ?? 0) + 1;
    globalState.__abrRateLimits!.set(key, { count, reset: Date.now() + windowSeconds * 1000 });
    for (const [entry, value] of globalState.__abrRateLimits!) if (value.reset < Date.now()) globalState.__abrRateLimits!.delete(entry);
  }
  if (count > maximum) throw new StoreError("Too many requests. Try again shortly.", 429);
}
