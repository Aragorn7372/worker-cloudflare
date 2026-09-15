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

    // Debug: estado sin adivinar (solo con secret para no exponer el origen
    // ni crear URLs duplicadas rastreables).
    const debugSecret = env.DEBUG_SECRET || "";
    const debugOk = debugSecret !== "" && request.headers.get("x-debug") === debugSecret;
    if (url.pathname === "/__cv-origin") {
      // Diagnóstico sin datos sensibles: solo si hay secret cargado en este deploy.
      console.log("[cv-debug] __cv-origin called, hasSecret=" + (debugSecret !== ""));
      if (!debugOk) {
        return new Response("Not found", { status: 404 });
      }
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

    // ?cv-origin=pi|netlify|github → fuerza origen (solo para probar, con secret;
    // sin secret se ignora para no crear URLs duplicadas indexables).
    const forced = debugOk ? url.searchParams.get("cv-origin") : null;
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

    // Si todo lo consultado dice 404 (y nada falló por red/5xx), la página no
    // existe: devolver 404 real en vez del mantenimiento (crawl budget + semántica).
    let sawNon404Failure = false;
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
        if (failed) {
          if (res.status !== 404) sawNon404Failure = true;
          continue;
        }
        return await finalize(res, label, isFallback, request, cache, cacheKey, ctx, env, suffix);
      } catch {
        sawNon404Failure = true;
        continue; // timeout o error de red → siguiente origen
      }
    }
    if (!sawNon404Failure) {
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain;charset=UTF-8", "x-cv-origin": "not-found", "cache-control": "no-store" },
      });
    }
    return new Response(MAINTENANCE_HTML, {
      status: 503,
      headers: {
        "content-type": "text/html;charset=UTF-8",
        "x-cv-origin": "maintenance",
        "cache-control": "no-store",
        "retry-after": "3600",
      },
    });
  },
};

async function finalize(res, label, isFallback, request, cache, cacheKey, ctx, env, suffix) {
  const headers = new Headers(res.headers);
  headers.set("x-cv-origin", label);
  const ct = (res.headers.get("content-type") || "").toLowerCase();

  // HTML de espejo: reescribe su dominio → cv (red de seguridad), inyecta canonical
  // (consolida SEO en cv aunque el espejo se indexe) + cachea 1h
  if (isFallback && ct.includes("text/html") && request.method === "GET") {
    let html = await res.text();
    for (const b of [env.FALLBACK_1, env.FALLBACK_2]) {
      if (b) html = html.split(norm(b)).join("https://cv.victor-service.dev");
    }
    if (!/<link[^>]+rel=["']canonical["']/i.test(html)) {
      const canonical = `<link rel="canonical" href="https://cv.victor-service.dev${suffix || "/"}">`;
      html = html.replace(/<head[^>]*>/i, (m) => m + canonical);
    }
    headers.set("cache-control", `public, max-age=${FALLBACK_TTL_S}`);
    const out = new Response(html, { status: res.status, headers });
    ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  }
  // Resto (assets, PDF, primario en streaming): pasa el body sin bufferizar
  if (isFallback && request.method === "GET") {
    headers.set("cache-control", `public, max-age=${FALLBACK_TTL_S}`);
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
