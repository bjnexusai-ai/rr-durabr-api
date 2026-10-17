import { signJwt } from './jwt.js';
import { RISTA_BASE } from './config.js';

export class RistaError extends Error {
  constructor(status, path) { super(`Rista ${status} on ${path}`); this.status = status; this.path = path; }
}

// GET only. This server never writes to Rista.
export async function ristaGet(env, path, params = {}, { timeoutMs = 8000 } = {}) {
  if (!env.RISTA_KEY || !env.RISTA_SECRET) throw new RistaError(0, 'missing-credentials');
  const url = new URL(RISTA_BASE + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
  const token = await signJwt(env.RISTA_KEY, env.RISTA_SECRET);
  const res = await fetch(url, {
    headers: { 'x-api-key': env.RISTA_KEY, 'x-api-token': token, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new RistaError(res.status, path);
  return res.json();
}
