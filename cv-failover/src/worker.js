// cv-failover: proxy con failover para cv.victor-service.dev
// Cadena: primario Pi (vía túnel) → Netlify → GitHub Pages → 503 inline.
// La URL visible se mantiene siempre (cv.victor-service.dev).
// Observabilidad: cabecera x-cv-origin (pi|netlify|github|netlify+cache|github+cache|maintenance).
// Debug: GET /__cv-origin → JSON. Test: ?cv-origin=pi|netlify|github fuerza origen.
//
// Vars (wrangler.toml [vars]): PRIMARY, FALLBACK_1, FALLBACK_2, FAILOVER_TIMEOUT_MS.

const FALLBACK_TTL_S = 3600; // caché de respuestas de espejo ante caída larga

const MAINTENANCE_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CV temporalmente no disponible</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0;text-align:center;padding:2rem}a{color:#7dd3fc}</style>
</head><body><main><h1>CV temporalmente no disponible</h1>
<p>El servicio principal no responde. Puedes ver el CV en sus espejos:</p>
<p><a href="https://aragorn7372.netlify.app/">Netlify</a> · <a href="https://aragorn7372.github.io/">GitHub Pages</a></p>
</main></body></html>`;

const norm = (b) => String(b || "").replace(/\/+$/, "");

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const timeoutMs = parseInt(env.FAILOVER_TIMEOUT_MS ?? "6000", 10);

    // Debug: estado sin adivinar
    if (url.pathname === "/__cv-origin") {
      return Response.json({
        primary: env.PRIMARY,
        fallbacks: [env.FALLBACK_1, env.FALLBACK_2].filter(Boolean),
        timeoutMs,
        now: new Date().toISOString(),
      });
    }

    // Solo GET/HEAD entran en failover; resto directo al primario
    if (request.method !== "GET" && request.method !== "HEAD") {
      return fetch(env.PRIMARY + url.pathname + url.search, request);
    }

    // ?cv-origin=pi|netlify|github → fuerza origen (solo para probar)
    const forced = url.searchParams.get("cv-origin");
    url.searchParams.delete("cv-origin");
    const suffix =
      url.pathname + (url.searchParams.toString() ? "?" + url.searchParams.toString() : "");
    const targets = [];
    if (forced === "netlify" && env.FALLBACK_1) targets.push([env.FALLBACK_1, "netlify", true]);
    else if (forced === "github" && env.FALLBACK_2) targets.push([env.FALLBACK_2, "github", true]);
    else if (forced === "pi") targets.push([env.PRIMARY, "pi", false]);
    else {
      targets.push([env.PRIMARY, "pi", false]);
      if (env.FALLBACK_1) targets.push([env.FALLBACK_1, "netlify", true]);
      if (env.FALLBACK_2) targets.push([env.FALLBACK_2, "github", true]);
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });

    for (const [base, label, isFallback] of targets) {
      // Solo los espejos consultan caché (el primario siempre en vivo)
      if (isFallback && request.method === "GET") {
        const hit = await cache.match(cacheKey);
        if (hit) return withOrigin(hit, label + "+cache");
      }
      try {
        const res = await fetch(norm(base) + suffix, {
          method: request.method,
          headers: request.headers,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        // Failover solo ante caída (red/timeout) o 5xx; los 4xx del primario son legítimos
        const failed = label === "pi" ? res.status >= 500 : !res.ok;
        if (failed) continue;
        return await finalize(res, label, isFallback, request, cache, cacheKey, ctx, env);
      } catch {
        continue; // timeout o error de red → siguiente origen
      }
    }
    return new Response(MAINTENANCE_HTML, {
      status: 503,
      headers: {
        "content-type": "text/html;charset=UTF-8",
        "x-cv-origin": "maintenance",
        "cache-control": "no-store",
      },
    });
  },
};

async function finalize(res, label, isFallback, request, cache, cacheKey, ctx, env) {
  const headers = new Headers(res.headers);
  headers.set("x-cv-origin", label);
  const ct = (res.headers.get("content-type") || "").toLowerCase();

  // HTML de espejo: reescribe su dominio → cv (red de seguridad) + cachea 1h
  if (isFallback && ct.includes("text/html") && request.method === "GET") {
    let html = await res.text();
    for (const b of [env.FALLBACK_1, env.FALLBACK_2]) {
      if (b) html = html.split(norm(b)).join("https://cv.victor-service.dev");
    }
    headers.set("cache-control": `public, max-age=${FALLBACK_TTL_S}`);
    const out = new Response(html, { status: res.status, headers });
    ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  }
  // Resto (assets, PDF, primario en streaming): pasa el body sin bufferizar
  if (isFallback && request.method === "GET") {
    headers.set("cache-control": `public, max-age=${FALLBACK_TTL_S}`);
    const out = new Response(res.body, { status: res.status, headers });
    ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  }
  return new Response(res.body, { status: res.status, headers });
}

function withOrigin(res, label) {
  const headers = new Headers(res.headers);
  headers.set("x-cv-origin", label);
  return new Response(res.body, { status: res.status, headers });
}
