/**
 * O Seu Radar — API principal
 * Notícias públicas, painel administrativo e sitemap.
 * Áudio das notícias: síntese de voz nativa do navegador (Web Speech API).
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

    // Auditoria protegida: lista notícias atualmente em IA para revisão de categoria.
    if (pathname === "/admin/category-audit" && request.method === "GET") {
      const requested = Number.parseInt(new URL(request.url).searchParams.get("limit") || "1000", 10);
      const limit = Number.isFinite(requested) ? Math.min(5000, Math.max(1, requested)) : 1000;
      const result = await env.DB.prepare(
        "SELECT id, category, title, excerpt, body, title_pt, excerpt_pt, body_pt, status, published_at FROM articles WHERE category = 'Inteligência Artificial' ORDER BY published_at DESC, id DESC LIMIT ?"
      ).bind(limit).all();
      return json({ count: (result.results || []).length, articles: result.results || [] }, 200, headers);
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, headers);
    let body;
    try { body = await request.json(); } catch { return json({ error: "JSON inválido." }, 400, headers); }

    if (pathname === "/admin/radar-daily/script") {
      const script = await generateRadarDailyScript(env);
      return json({ ok: true, script }, 200, headers);
    }

    // Aplicação explícita e restrita: somente IDs enviados e ainda classificados como IA.
    if (pathname === "/admin/category-audit/apply") {
      if (!Array.isArray(body?.ids) || body.ids.length < 1 || body.ids.length > 500) {
        return json({ error: "Envie uma lista de 1 a 500 IDs numéricos." }, 400, headers);
      }
      const ids = [...new Set(body.ids.map(Number))];
      if (ids.some(id => !Number.isInteger(id) || id <= 0)) return json({ error: "A lista contém ID inválido." }, 400, headers);
      const statements = ids.map(id => env.DB.prepare(
        "UPDATE articles SET category = 'Tecnologia da Informação' WHERE id = ? AND category = 'Inteligência Artificial'"
      ).bind(id));
      const results = await env.DB.batch(statements);
      const changed = results.reduce((sum, result) => sum + Number(result.meta?.changes || 0), 0);
      return json({ ok: true, requested: ids.length, changed, skipped: ids.length - changed, category: "Tecnologia da Informação" }, 200, headers);
    }

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
import { generateRadarDailyScript } from "./radar-daily.js";

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
