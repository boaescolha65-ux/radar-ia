/**
 * O Seu Radar — API de notícias + proxy Edge TTS
 * GET /api/articles.json?limit=100 — lista notícias publicadas do D1.
 * GET /api/articles.json?id=123 — devolve uma notícia publicada.
 * POST /api/tts — encaminha a síntese ao serviço privado no Render.
 *
 * D1 binding: DB -> radar-ia-db
 * Secrets: EDGE_TTS_API_KEY
 * Optional KV binding: TTS_KV
 */
const EDGE_TTS_URL = "https://radar-ia-mlww.onrender.com/api/tts";
const MAX_TEXT = 1400;
const DAILY_LIMIT = 40;
const CACHE_TTL = 60 * 60 * 24 * 14;
const ALLOWED_ORIGINS = new Set([
  "https://oseuradar.com.br",
  "https://www.oseuradar.com.br",
  "https://radar-ia-2o2.pages.dev",
  "https://radar-ia-page.pages.dev"
]);

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "https://oseuradar.com.br";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
async function rateLimit(env, ip) {
  if (!env.TTS_KV) return true;
  const key = "limit:" + (await sha256(ip || "unknown")).slice(0, 32);
  const current = Number(await env.TTS_KV.get(key) || 0);
  if (current >= DAILY_LIMIT) return false;
  await env.TTS_KV.put(key, String(current + 1), { expirationTtl: 86400 });
  return true;
}

async function handleArticles(request, env, headers) {
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405, headers);
  }
  if (!env.DB) {
    return json({ error: "D1 binding DB não configurado no Worker." }, 503, headers);
  }

  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  const columns = `
    id, category, title, excerpt, body, source_name, source_url,
    published_at, status, created_at, title_pt, excerpt_pt, body_pt,
    image_url, video_url
  `;

  try {
    if (id) {
      const article = await env.DB.prepare(
        `SELECT ${columns} FROM articles WHERE id = ? AND status = 'published' LIMIT 1`
      ).bind(id).first();

      if (!article) return json({ error: "Notícia não encontrada." }, 404, headers);
      return json(article, 200, headers);
    }

    const requestedLimit = Number.parseInt(url.searchParams.get("limit") || "100", 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, requestedLimit))
      : 100;

    const result = await env.DB.prepare(
      `SELECT ${columns} FROM articles
       WHERE status = 'published'
       ORDER BY published_at DESC, id DESC
       LIMIT ?`
    ).bind(limit).all();

    return json({ articles: result.results || [] }, 200, headers);
  } catch (error) {
    console.error("D1 articles query failed:", error);
    return json({ error: "Falha ao consultar as notícias no banco D1." }, 500, headers);
  }
}

async function handleTTS(request, env, headers) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, headers);
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "JSON inválido." }, 400, headers); }

  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return json({ error: "Texto vazio." }, 400, headers);
  if (text.length > MAX_TEXT) return json({ error: "Trecho excede 1.400 caracteres." }, 413, headers);
  if (!env.EDGE_TTS_API_KEY) {
    return json({ error: "Configure o segredo EDGE_TTS_API_KEY no Worker." }, 503, headers);
  }

  const cacheKey = "edge-audio:pt-BR-FranciscaNeural:" + await sha256(text);
  if (env.TTS_KV) {
    try {
      const cached = await env.TTS_KV.get(cacheKey, "arrayBuffer");
      if (cached) return new Response(cached, {
        status: 200,
        headers: { ...headers, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400", "X-TTS-Cache": "HIT" }
      });
    } catch (error) { console.warn("Cache read failed:", error); }
  }

  try {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!(await rateLimit(env, ip))) {
      return json({ error: "Limite diário de 40 trechos por IP atingido. Tente amanhã." }, 429, headers);
    }
    const response = await fetch(EDGE_TTS_URL, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.EDGE_TTS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Render Edge TTS error:", response.status, detail.slice(0, 500));
      return json({
        error: response.status === 401
          ? "A chave de acesso do serviço de áudio não foi aceita."
          : response.status === 429
            ? "O serviço de áudio está temporariamente limitado. Tente novamente."
            : "Não foi possível gerar o áudio. Tente novamente em instantes."
      }, response.status === 429 ? 429 : 502, headers);
    }

    const audio = await response.arrayBuffer();
    if (!audio.byteLength || audio.byteLength > 4 * 1024 * 1024) {
      return json({ error: "Áudio vazio ou maior que 4 MB." }, 502, headers);
    }
    if (env.TTS_KV) {
      try { await env.TTS_KV.put(cacheKey, audio, { expirationTtl: CACHE_TTL }); }
      catch (error) { console.warn("Cache write failed:", error); }
    }
    return new Response(audio, {
      status: 200,
      headers: { ...headers, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400", "X-TTS-Cache": "MISS" }
    });
  } catch (error) {
    console.error("Edge TTS proxy error:", error);
    return json({ error: "Falha ao conectar ao serviço Edge TTS. Tente novamente." }, 502, headers);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return json({ error: "Origin not allowed" }, 403, headers);
    }

    if (url.pathname === "/api/articles.json") {
      return handleArticles(request, env, headers);
    }
    if (url.pathname === "/api/tts") {
      return handleTTS(request, env, headers);
    }
    return json({ error: "Not found" }, 404, headers);
  }
};
