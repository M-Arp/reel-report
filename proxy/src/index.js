// Reel Report lookup service: a small Cloudflare Worker that looks titles up on TMDB
// with the site owner's key, so visitors don't need one.
//
//   GET /title/tt0119174  -> { c: [[personId, name], ...up to 8], col: [collectionId, name] | null }
//   GET /collection/9485  -> { name, total }   (total = entries already released)
//
// The TMDB key lives in the TMDB_KEY secret (API key or API Read Access Token).

const ALLOWED_ORIGINS = ["https://m-arp.github.io"];
const TMDB = "https://api.themoviedb.org/3";
const CACHE_SECONDS = 60 * 60 * 24 * 7;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response("Origin not allowed", { status: 403 });
    const cors = {
      "Access-Control-Allow-Origin": origin || ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "Only GET is supported" }, 405, cors);
    if (!env.TMDB_KEY) return json({ error: "The lookup service has no TMDB key configured" }, 500, cors);

    const url = new URL(request.url);
    let handler, m;
    if ((m = url.pathname.match(/^\/title\/(tt\d{5,10})$/))) handler = () => lookupTitle(m[1], env.TMDB_KEY);
    else if ((m = url.pathname.match(/^\/collection\/(\d{1,10})$/))) handler = () => lookupCollection(m[1], env.TMDB_KEY);
    else return json({ error: "Not found" }, 404, cors);

    const cache = caches.default;
    const cacheKey = new Request(url.origin + url.pathname);
    let res = await cache.match(cacheKey);
    if (!res) {
      let body;
      try { body = await handler(); }
      catch (e) { return json({ error: e.message }, e.status || 502, cors); }
      res = new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }
    res = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

class LookupError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function tmdb(path, params, key) {
  const url = new URL(TMDB + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const headers = { accept: "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
  else url.searchParams.set("api_key", key);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 800 * (attempt + 1))); continue; }
    if (res.status === 404) return null;
    if (res.status === 401) throw new LookupError("The lookup service's TMDB key was rejected", 500);
    if (!res.ok) throw new LookupError(`TMDB returned ${res.status}`, 502);
    return res.json();
  }
  throw new LookupError("TMDB is limiting requests; try again shortly", 429);
}

async function lookupTitle(imdbId, key) {
  const found = await tmdb(`/find/${imdbId}`, { external_source: "imdb_id" }, key);
  const movie = found?.movie_results?.[0];
  const show = found?.tv_results?.[0];
  const cast = list => (list || []).slice(0, 8).map(p => [p.id, p.name]);
  if (movie) {
    const d = await tmdb(`/movie/${movie.id}`, { append_to_response: "credits" }, key);
    const col = d?.belongs_to_collection;
    return { c: cast(d?.credits?.cast), col: col ? [col.id, col.name] : null };
  }
  if (show) {
    const d = await tmdb(`/tv/${show.id}`, { append_to_response: "aggregate_credits" }, key);
    return { c: cast(d?.aggregate_credits?.cast), col: null };
  }
  return { c: [], col: null };
}

async function lookupCollection(id, key) {
  const d = await tmdb(`/collection/${id}`, {}, key);
  if (!d) throw new LookupError("Collection not found", 404);
  const today = new Date().toISOString().slice(0, 10);
  return { name: d.name, total: (d.parts || []).filter(p => p.release_date && p.release_date <= today).length };
}
