// Small in-memory cache with 3 protections:
// 1) fresh answer for `ttl` seconds  2) many visitors at once = ONE call to Rista
// 3) if Rista fails, serve the last good answer for up to `stale` seconds.
// Note: each Cloudflare "isolate" has its own memory. That is fine at this scale.
const store = new Map();
const inflight = new Map();

export async function cached(key, ttl, stale, fn) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && now - hit.t < ttl * 1000) return { value: hit.v, stale: false };
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const v = await fn();
      store.set(key, { v, t: Date.now() });
      return { value: v, stale: false };
    } catch (e) {
      if (hit && now - hit.t < stale * 1000) return { value: hit.v, stale: true };
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// Simple "do not retry for N seconds" memory (used when an optional call fails, so we do not hammer Rista).
const backoff = new Map();
export const isBackedOff = (key) => (backoff.get(key) || 0) > Date.now();
export const setBackoff = (key, secs) => backoff.set(key, Date.now() + secs * 1000);

export function _clear() { store.clear(); inflight.clear(); backoff.clear(); }
