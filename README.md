# worker-cloudflare

Proxy con failover para `cv.victor-service.dev`, desplegado como Cloudflare Worker
(`cv-failover`) con Git integration sobre `main`.

## Cadena de orígenes

```
Pi (túnel) → Netlify → GitHub Pages → 503 inline
```

La URL visible se mantiene siempre (`cv.victor-service.dev`). Solo GET/HEAD entran
en failover; el resto de métodos van directos al primario. Los 4xx del primario se
sirven tal cual (son legítimos); el failover salta ante caída de red, timeout o 5xx.
Si todo devuelve 404 inexistente, responde 404 real; si hubo caída real, 503 con
`Retry-After: 3600` para que Google reintente en vez de penalizar.

## Observabilidad

Cada respuesta lleva la cabecera **`x-cv-origin`**:

| Valor | Significado |
|---|---|
| `pi` | Sirve la Raspberry en vivo (sin caché) |
| `netlify` / `github` | Espejo en vivo (el Pi no respondió a tiempo) |
| `netlify+cache` / `github+cache` | Espejo desde caché del edge (caída larga del Pi) |
| `not-found` | La página no existe en ningún origen (404) |
| `maintenance` | Todo caído (503, reintentar luego) |

Comprobación rápida (PowerShell):

```powershell
(curl.exe -sI https://cv.victor-service.dev/ | Select-String "x-cv-origin").ToString()
```

Para forzar lectura en vivo saltando cachés, añade un query inédito: `?x=123`.

### Debug (con secret)

`GET /__cv-origin` devuelve la config (orígenes, timeout) y `?cv-origin=pi|netlify|github`
fuerza un origen para probar. Ambos exigen la cabecera `x-debug` con el valor del
secret `DEBUG_SECRET`; sin ella responden 404 y el parámetro se ignora.

```powershell
curl.exe -i -H "x-debug: TU-SECRETO" https://cv.victor-service.dev/__cv-origin
```

## Configuración (`cv-failover/wrangler.toml`)

| Variable | Valor | Descripción |
|---|---|---|
| `PRIMARY` | `https://cv-origin.victor-service.dev` | Origen principal (Pi vía túnel) |
| `FALLBACK_1` | `https://aragorn7372.netlify.app/` | Espejo 1 |
| `FALLBACK_2` | `https://aragorn7372.github.io/` | Espejo 2 |
| `FAILOVER_TIMEOUT_MS` | `2500` | Timeout por nivel antes de saltar al siguiente |
| `DEBUG_SECRET` | *(secret en dashboard, nunca aquí)* | Habilita el debug |

Ruta publicada (`[[routes]]`): `cv.victor-service.dev/*` en la zona `victor-service.dev`.

## Despliegue

* Producción = rama `main`, despliegue automático desde el dashboard (root `/cv-failover`,
  sin build command, deploy `npx wrangler deploy`, sin previews ni Access).
* Tras tocar variables/secrets, **redeploy obligatorio** para que apliquen.
* No duplicar con `.github/workflows/deploy-cv-worker.yml`: una sola vía de despliegue
  (dashboard). El workflow está desactivado.
* Verificar cada deploy: hash del deployment = `git log -1` local, y los curl de
  [observabilidad](#observabilidad) más `canonical`, 404 real y `noindex` del espejo.

## SEO

* Canonical absoluto a `cv.victor-service.dev` (en el `index.html` del CV + inyectado
  por el worker en el HTML de espejos).
* `robots.txt` + `sitemap.xml` en el CV; `X-Robots-Tag: noindex` en el deploy de Netlify
  (GitHub Pages lo cubre el canonical).
