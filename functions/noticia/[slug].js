const API = "https://radar-ia-api.boaescolha65.workers.dev/api/articles.json";
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const slugify = v => String(v || "noticia").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,90).replace(/-+$/g,"") || "noticia";
const bodyHtml = value => {
  const raw = String(value || "").replace(/\r\n?/g,"\n").trim();
  if (!raw) return "<p>O conteúdo desta publicação não está disponível no momento.</p>";
  return raw.split(/\n{2,}/).map(block => {
    const lines = block.split("\n").map(x => x.trim()).filter(Boolean);
    const heading = block.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length + 1;
      return "<h" + level + ">" + esc(heading[2]) + "</h" + level + ">";
    }
    if (lines.length && lines.every(x => /^[-•*]\s+/.test(x))) return "<ul>" + lines.map(x => "<li>" + esc(x.replace(/^[-•*]\s+/,"")) + "</li>").join("") + "</ul>";
    return "<p>" + lines.map(esc).join("<br>") + "</p>";
  }).join("");
};
export async function onRequest(context) {
  const slug = String(context.params.slug || "");
  const found = slug.match(/-(\d+)$/);
  if (!found) return context.next();
  const id = found[1];
  const asset = await context.next();
  if (!asset || !asset.ok) return asset;
  let article;
  try {
    const response = await fetch(API + "?id=" + encodeURIComponent(id), {headers:{"Accept":"application/json"}});
    if (!response.ok) return new Response("Notícia não encontrada.",{status:404});
    article = await response.json();
  } catch (error) {
    console.error("Falha ao buscar artigo para renderização:",error);
    return asset;
  }
  if (!article || String(article.id) !== id || article.status !== "published") return new Response("Notícia não encontrada.",{status:404});
  const title = String(article.title_pt || article.title || "Notícia");
  const excerpt = String(article.excerpt_pt || article.excerpt || "");
  const body = String(article.body_pt || article.body || excerpt);
  const source = String(article.source_name || "Fonte original");
  const sourceUrl = /^https?:\/\//i.test(String(article.source_url || "")) ? String(article.source_url) : "";
  async function resolveImageUrl(value) {
    const original = String(value || "").trim();
    if (!/^https?:\/\//i.test(original)) return "";
    try {
      const response = await fetch(original, {
        redirect: "follow",
        headers: { "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" }
      });
      if (!response.ok) return "";
      const type = (response.headers.get("content-type") || "").toLowerCase();
      if (type.startsWith("image/")) return response.url || original;
      if (type.includes("text/html") || type.includes("application/xhtml")) {
        const html = await response.text();
        const tags = [
          /<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
          /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["'][^>]*>/i,
          /<meta[^>]+(?:name|property)=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
          /<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']twitter:image["'][^>]*>/i
        ];
        for (const pattern of tags) {
          const match = html.match(pattern);
          if (match && match[1]) {
            const candidate = new URL(match[1].replace(/&amp;/g, "&"), response.url || original);
            if (candidate.protocol === "https:" || candidate.protocol === "http:") return candidate.href;
          }
        }
      }
    } catch (error) {
      console.warn("Não foi possível resolver a URL da imagem:", String(error));
    }
    return "";
  }
  const image = await resolveImageUrl(article.image_url);
  const canonical = "https://oseuradar.com.br/noticia/" + slugify(title) + "-" + id;
  const date = article.published_at || article.created_at || "";
  const description = (excerpt || body).replace(/\s+/g," ").slice(0,155);
  const jsonArticle = JSON.stringify(article).replace(/</g,"\\u003c").replace(/>/g,"\\u003e").replace(/&/g,"\\u0026");
  const content = '<span class="category-tag">' + esc(article.category || "Geral") + '</span>' +
    '<h1>' + esc(title) + '</h1><div class="detail-meta"><span>' + esc(source) + '</span><span>·</span><time>' +
    esc(date ? new Date(date).toLocaleDateString("pt-BR") : "Data não informada") + '</time></div>' +
    (image ? '<img class="detail-image" src="' + esc(image) + '" alt="' + esc(title) + '">' : '') +
    (excerpt ? '<p class="article-subtitle">' + esc(excerpt) + '</p>' : '') +
    '<div class="article-detail-content">' + bodyHtml(body) + '</div>' +
    '<div class="source-box"><strong>Fonte original:</strong> ' +
    (sourceUrl ? '<a href="' + esc(sourceUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(source) + '</a>' : esc(source)) + '</div>';
  const schema = {"@context":"https://schema.org","@type":"NewsArticle","headline":title,"description":description,"url":canonical,"mainEntityOfPage":{"@type":"WebPage","@id":canonical},"author":{"@type":"Organization","name":"O Seu Radar"},"publisher":{"@type":"Organization","name":"O Seu Radar"},"inLanguage":"pt-BR","articleSection":String(article.category || "Geral"),"isAccessibleForFree":true};
  if (image) schema.image = [image];
  if (date && !Number.isNaN(Date.parse(date))) schema.datePublished = new Date(date).toISOString();
  if (sourceUrl) schema.citation = sourceUrl;
  let html = await asset.text();
  html = html.replace(/<title>[\s\S]*?<\/title>/i,"<title>" + esc(title) + " | O Seu Radar</title>");
  html = html.replace(/<meta name="description" id="pageDescription" content="[^"]*">/i,'<meta name="description" id="pageDescription" content="' + esc(description) + '">');
  html = html.replace(/<link rel="canonical" id="pageCanonical" href="[^"]*">/i,'<link rel="canonical" id="pageCanonical" href="' + esc(canonical) + '">');
  html = html.replace(/<article class="article-detail" id="articleDetail">[\s\S]*?<\/article>/i,'<article class="article-detail" id="articleDetail">' + content + '</article>');
  html = html.replace('<script>\n    "use strict";','<script>window.__INITIAL_ARTICLE__=' + jsonArticle + ';</script>\n  <script>\n    "use strict";');
  html = html.replace("</head>",'<script type="application/ld+json">' + JSON.stringify(schema).replace(/</g,"\\u003c") + '</script>\n</head>');
  const headers = new Headers(asset.headers);
  headers.set("Content-Type","text/html; charset=utf-8");
  headers.set("Cache-Control","public, max-age=60, s-maxage=300");
  return new Response(html,{status:200,headers});
}
