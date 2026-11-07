// What the key-holding server can do right now (GET /api/health), fetched once and cached.
// Without the server (plain `npm run dev`), everything reads false.

export interface ServerHealth {
  ok: boolean;
  gemini: boolean;
  elevenlabs: boolean;
  live: boolean;
}

export const OFFLINE: ServerHealth = { ok: false, gemini: false, elevenlabs: false, live: false };

let cached: Promise<ServerHealth> | null = null;

export function getServerHealth(opts: { fetch?: typeof fetch; refresh?: boolean; url?: string; timeoutMs?: number } = {}): Promise<ServerHealth> {
  if (cached && !opts.refresh) return cached;
  const fetchFn = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  cached = (async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 3000);
    try {
      const r = await fetchFn(opts.url ?? '/api/health', { signal: ac.signal, cache: 'no-store' });
      if (!r.ok) return OFFLINE;
      const j = (await r.json()) as Partial<ServerHealth>;
      return { ok: !!j.ok, gemini: !!j.gemini, elevenlabs: !!j.elevenlabs, live: !!(j.live ?? j.gemini) };
    } catch {
      return OFFLINE;
    } finally {
      clearTimeout(timer);
    }
  })();
  return cached;
}
