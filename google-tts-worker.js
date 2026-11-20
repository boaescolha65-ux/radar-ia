/**
 * O Seu Radar — API principal
 * Notícias públicas, painel administrativo e sitemap.
 * Áudio removido: /api/tts retorna 410 até a adoção de uma nova solução.
 *
 * Cloudflare bindings:
 *   DB -> radar-ia-db (D1)
 * Secrets:
 *   ADMIN_TOKEN
 */
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}
function xmlEscape(value) {
  return String(value ?? "").replace(/[<>&'"`]/g, ch => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;", "`": "&apos;"
  }[ch]));
}
function slugifyTitle(value) {
  return String(value || "noticia").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 90).replace(/-+$/g, "") || "noticia";
}
function authorized(request, env) {
  const token = request.headers.get("Authorization") || "";
  return Boolean(env.ADMIN_TOKEN && token === "Bearer " + env.ADMIN_TOKEN);
}

const EDGE_TTS_URL = "https://radar-ia-mlww.onrender.com/api/tts";
const TTS_MAX_TEXT = 1400;
const TTS_DAILY_LIMIT = 40;
const TTS_CACHE_TTL = 60 * 60 * 24 * 14;

async function ttsSha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

async function ttsRateLimit(env, ip) {
  if (!env.TTS_KV) return true;
  const key = "tts-limit:" + (await ttsSha256(ip || "unknown")).slice(0, 32);
  const current = Number(await env.TTS_KV.get(key) || 0);
  if (current >= TTS_DAILY_LIMIT) return false;
  await env.TTS_KV.put(key, String(current + 1), { expirationTtl: 86400 });
  return true;
}

async function handleTTS(request, env, headers) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, headers);
  if (!env.EDGE_TTS_API_KEY) {
    return json({ error: "Serviço de áudio não configurado: falta o secret EDGE_TTS_API_KEY no Worker." }, 503, headers);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "JSON inválido." }, 400, headers); }

  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return json({ error: "Texto vazio." }, 400, headers);
  if (text.length > TTS_MAX_TEXT) {
    return json({ error: "Trecho excede 1.400 caracteres." }, 413, headers);
  }

  const cacheKey = "edge-audio:pt-BR-FranciscaNeural:" + await ttsSha256(text);
  if (env.TTS_KV) {
    try {
      const cached = await env.TTS_KV.get(cacheKey, "arrayBuffer");
      if (cached) {
        return new Response(cached, {
          status: 200,
          headers: { ...headers, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400", "X-TTS-Cache": "HIT" }
        });
      }
    } catch (error) {
      console.warn("[TTS] falha ao ler cache KV:", String(error));
    }
  }

  try {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!(await ttsRateLimit(env, ip))) {
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
      console.error("[TTS] Render respondeu com erro:", response.status, detail.slice(0, 500));
      return json({
        error: response.status === 401
          ? "A autenticação do serviço de áudio no Render falhou."
          : response.status === 429
            ? "O serviço de áudio está temporariamente limitado."
            : "O Render não conseguiu gerar o áudio. Tente novamente."
      }, response.status === 429 ? 429 : 502, headers);
    }

    const audio = await response.arrayBuffer();
    const contentType = response.headers.get("Content-Type") || "";
    if (!audio.byteLength || audio.byteLength > 4 * 1024 * 1024 || !contentType.toLowerCase().includes("audio/")) {
      return json({ error: "O Render retornou um arquivo de áudio inválido ou vazio." }, 502, headers);
    }

    if (env.TTS_KV) {
      try { await env.TTS_KV.put(cacheKey, audio, { expirationTtl: TTS_CACHE_TTL }); }
      catch (error) { console.warn("[TTS] falha ao gravar cache KV:", String(error)); }
    }

    return new Response(audio, {
      status: 200,
      headers: { ...headers, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400", "X-TTS-Cache": "MISS" }
    });
  } catch (error) {
    console.error("[TTS] falha na conexão com Render:", error && error.stack ? error.stack : String(error));
    return json({ error: "Não foi possível conectar ao serviço de áudio no Render." }, 502, headers);
  }
}

async function handleArticles(request, env, headers) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, headers);
  if (!env.DB) return json({ error: "D1 binding DB não configurado." }, 503, headers);
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const columns = "id, category, title, excerpt, body, source_name, source_url, published_at, status, created_at, title_pt, excerpt_pt, body_pt, image_url, video_url";
  try {
    if (id) {
      const article = await env.DB.prepare(`SELECT ${columns} FROM articles WHERE id = ? AND status = 'published' LIMIT 1`).bind(id).first();
      return article ? json(article, 200, headers) : json({ error: "Notícia não encontrada." }, 404, headers);
    }
    const requested = Number.parseInt(url.searchParams.get("limit") || "100", 10);
    const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, requested)) : 100;
    const result = await env.DB.prepare(`SELECT ${columns} FROM articles WHERE status = 'published' ORDER BY published_at DESC, id DESC LIMIT ?`).bind(limit).all();
    return json({ articles: result.results || [] }, 200, headers);
  } catch (error) {
    console.error("D1 public articles query failed:", error);
    return json({ error: "Falha ao consultar notícias no D1." }, 500, headers);
  }
}
async function handleAdmin(request, env, headers, pathname) {
  if (!authorized(request, env)) return json({ error: "Token administrativo inválido ou ADMIN_TOKEN ausente." }, 401, headers);
  if (!env.DB) return json({ error: "D1 binding DB não configurado." }, 503, headers);
  try {
    if (pathname === "/admin/articles" && request.method === "GET") {
      const result = await env.DB.prepare(
        "SELECT id, category, title, excerpt, body, source_name, source_url, published_at, status, created_at, title_pt, excerpt_pt, body_pt, image_url, video_url FROM articles WHERE status IN ('pending_review','pending','draft') ORDER BY created_at DESC, id DESC LIMIT 200"
      ).all();
      return json({ articles: result.results || [] }, 200, headers);
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, headers);
    let body;
    try { body = await request.json(); } catch { return json({ error: "JSON inválido." }, 400, headers); }

    if (pathname === "/admin/approve" || pathname === "/admin/reject") {
      const id = Number(body?.id);
      if (!Number.isInteger(id) || id <= 0) return json({ error: "ID inválido." }, 400, headers);
      const status = pathname.endsWith("/approve") ? "published" : "rejected";
      const result = await env.DB.prepare(
        "UPDATE articles SET status = ?, published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, CURRENT_TIMESTAMP) ELSE published_at END WHERE id = ?"
      ).bind(status, status, id).run();
      if (!result.meta?.changes) return json({ error: "Notícia não encontrada." }, 404, headers);
      return json({ ok: true, id, status }, 200, headers);
    }

    if (pathname === "/admin/update-image") {
      const id = Number(body?.id);
      const imageUrl = String(body?.image_url ?? "").trim();
      if (!Number.isInteger(id) || id <= 0) return json({ error: "ID inválido." }, 400, headers);
      if (imageUrl && !/^https?:\/\//i.test(imageUrl)) return json({ error: "A imagem deve usar um endereço HTTP ou HTTPS." }, 400, headers);
      const result = await env.DB.prepare(
        "UPDATE articles SET image_url = ? WHERE id = ?"
      ).bind(imageUrl || null, id).run();
      if (!result.meta?.changes) return json({ error: "Notícia não encontrada ou imagem já estava igual." }, 404, headers);
      return json({ ok: true, id, image_url: imageUrl || null }, 200, headers);
    }

    if (pathname === "/admin/update-article") {
      const id = Number(body?.id);
      const title = String(body?.title_pt ?? "").trim();
      const excerpt = String(body?.excerpt_pt ?? "").trim();
      const articleBody = String(body?.body_pt ?? "").trim();
      if (!Number.isInteger(id) || id <= 0 || !title || !articleBody) return json({ error: "ID, título e reportagem são obrigatórios." }, 400, headers);
      const result = await env.DB.prepare(
        "UPDATE articles SET title_pt = ?, excerpt_pt = ?, body_pt = ? WHERE id = ?"
      ).bind(title, excerpt, articleBody, id).run();
      if (!result.meta?.changes) return json({ error: "Notícia não encontrada." }, 404, headers);
      return json({ ok: true, id }, 200, headers);
    }

    if (pathname === "/admin/create-article") {
      const title = String(body?.title ?? "").trim();
      const category = String(body?.category ?? "").trim();
      const excerpt = String(body?.excerpt ?? "").trim();
      const articleBody = String(body?.body ?? "").trim();
      const sourceName = String(body?.sourceName ?? "").trim();
      const sourceUrl = String(body?.sourceUrl ?? "").trim();
      const imageUrl = String(body?.imageUrl ?? "").trim();
      const videoUrl = String(body?.videoUrl ?? "").trim();
      if (!title || !category || !excerpt || articleBody.length < 500 || !sourceName || !/^https?:\/\//i.test(sourceUrl)) {
        return json({ error: "Preencha os campos obrigatórios. A reportagem precisa ter pelo menos 500 caracteres e a fonte deve ser uma URL HTTP(S)." }, 400, headers);
      }
      const result = await env.DB.prepare(
        "INSERT INTO articles (category, title, excerpt, body, source_name, source_url, status, created_at, published_at, title_pt, excerpt_pt, body_pt, image_url, video_url) VALUES (?, ?, ?, ?, ?, ?, 'pending_review', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?)"
      ).bind(category, title, excerpt, articleBody, sourceName, sourceUrl, title, excerpt, articleBody, imageUrl || null, videoUrl || null).run();
      return json({ ok: true, id: result.meta?.last_row_id, status: "pending_review" }, 201, headers);
    }
    return json({ error: "Rota administrativa não encontrada." }, 404, headers);
  } catch (error) {
    console.error("Admin API error:", error);
    return json({ error: "Falha ao executar operação administrativa no D1. Verifique o schema da tabela articles." }, 500, headers);
  }
}
async function handleSitemap(env) {
  if (!env.DB) return new Response("D1 binding DB não configurado.", { status: 503 });
  try {
    const result = await env.DB.prepare("SELECT id, title, published_at FROM articles WHERE status = 'published' ORDER BY published_at DESC, id DESC LIMIT 5000").all();
    const urls = (result.results || []).map(article => {
      const loc = "https://oseuradar.com.br/noticia/" + slugifyTitle(article.title) + "-" + encodeURIComponent(article.id);
      const lastmod = article.published_at ? "<lastmod>" + xmlEscape(new Date(article.published_at).toISOString()) + "</lastmod>" : "";
      return "<url><loc>" + xmlEscape(loc) + "</loc>" + lastmod + "</url>";
    }).join("");
    return new Response('<?xml version="1.0" encoding="UTF-8"?>' + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://oseuradar.com.br/</loc></url>' + urls + '</urlset>', {
      status: 200, headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=1800" }
    });
  } catch (error) {
    console.error("Sitemap generation failed:", error);
    return new Response("Falha ao gerar sitemap.", { status: 500 });
  }
}
import { runNewsGeneration } from "./news-generator.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed" }, 403, headers);
    if (url.pathname === "/robots.txt" && request.method === "GET") {
      return new Response("User-agent: *\nAllow: /\nDisallow: /admin\n\nSitemap: https://oseuradar.com.br/sitemap.xml\n", {
        status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" }
      });
    }
    if (url.pathname === "/sitemap.xml" && request.method === "GET") return handleSitemap(env);
    if (url.pathname === "/api/articles.json") return handleArticles(request, env, headers);
    if (url.pathname === "/api/tts") return handleTTS(request, env, headers);
    if (url.pathname.startsWith("/admin/")) return handleAdmin(request, env, headers, url.pathname);
    return json({ error: "Not found" }, 404, headers);
  },
  async scheduled(controller, env, ctx) {
    console.log("[CRON] evento agendado recebido", JSON.stringify({scheduledTime:controller?.scheduledTime,cron:controller?.cron}));
    const task = runNewsGeneration(env).then(result => {
      console.log("[CRON] geração finalizada", JSON.stringify(result));
    }).catch(error => {
      console.error("[CRON] falha na geração automática de notícias:", error && error.stack ? error.stack : String(error));
    });
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(task);
    else await task;
  }
};