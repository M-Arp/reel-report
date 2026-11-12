// Reel Report lookup service: a small Cloudflare Worker that looks titles up on TMDB
// with the site owner's key, so visitors don't need one.
//
//   GET /v3/title/tt0119174 -> {
//     tid: "m2649" | "t1396"   TMDB id, prefixed m (film) or t (TV)
//     c:   [[personId, name], ...]   top 8 billed cast
//     col: [collectionId, name] | null   film series (films only)
//     s:   [[id, name], ...]   up to 3 production companies (films) or networks (TV)
//     cr:  [[personId, name], ...]   creators (TV only)
//     ns:  number of seasons (TV only)
//     lg:  original language code;  co: country codes
//   }
//   GET /title, /v2/title   -> same as /v3/title (kept for older pages)
//   GET /collection/9485    -> { name, total }   (total = entries already released)
//   GET /v3/recs/m2649      -> TMDB's recommendations for that title, up to 20:
//     [[tmdbId, title, releaseDate, voteAverage, voteCount, posterPath, genreIds], ...]
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
    if ((m = url.pathname.match(/^(?:\/v[23])?\/title\/(tt\d{5,10})$/))) handler = () => lookupTitle(m[1], env.TMDB_KEY);
    else if ((m = url.pathname.match(/^\/collection\/(\d{1,10})$/))) handler = () => lookupCollection(m[1], env.TMDB_KEY);
    else if ((m = url.pathname.match(/^\/v3\/recs\/([mt])(\d{1,10})$/))) handler = () => lookupRecs(m[1], m[2], env.TMDB_KEY);
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
  const pairs = (list, n) => (list || []).slice(0, n).map(p => [p.id, p.name]);
  if (movie) {
    const d = await tmdb(`/movie/${movie.id}`, { append_to_response: "credits" }, key);
    const col = d?.belongs_to_collection;
    return { tid: "m" + movie.id, c: pairs(d?.credits?.cast, 8), col: col ? [col.id, col.name] : null, s: pairs(d?.production_companies, 3),
      lg: d?.original_language || null, co: (d?.production_countries || []).map(x => x.iso_3166_1) };
  }
  if (show) {
    const d = await tmdb(`/tv/${show.id}`, { append_to_response: "aggregate_credits" }, key);
    return { tid: "t" + show.id, c: pairs(d?.aggregate_credits?.cast, 8), col: null, s: pairs(d?.networks, 3), cr: pairs(d?.created_by, 4),
      ns: d?.number_of_seasons ?? null, lg: d?.original_language || null, co: d?.origin_country || [] };
  }
  return { c: [], col: null };
}

async function lookupRecs(kind, id, key) {
  const d = await tmdb(`/${kind === "m" ? "movie" : "tv"}/${id}/recommendations`, {}, key);
  return (d?.results || []).slice(0, 20).map(r => [r.id, r.title || r.name || "", r.release_date || r.first_air_date || "",
    Math.round((r.vote_average || 0) * 10) / 10, r.vote_count || 0, r.poster_path || null, r.genre_ids || []]);
}

async function lookupCollection(id, key) {
  const d = await tmdb(`/collection/${id}`, {}, key);
  if (!d) throw new LookupError("Collection not found", 404);
  const today = new Date().toISOString().slice(0, 10);
  return { name: d.name, total: (d.parts || []).filter(p => p.release_date && p.release_date <= today).length };
}
