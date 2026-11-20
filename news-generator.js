export async function runNewsGeneration(env) {
  console.log("[NEWS] início da geração", new Date().toISOString());
  if (!env.DB) throw new Error("D1 DB não configurado");
  const key = env.AI_API_KEY || env.GROQ_API_KEY || env.GROQ_API_TOKEN;
  if (!key) throw new Error("Configure AI_API_KEY ou GROQ_API_KEY como Secret no Worker");
  const daily = await env.DB.prepare("SELECT COUNT(*) AS total FROM articles WHERE created_at >= datetime('now','start of day')").first();
  if (Number(daily.total || 0) >= 6) { console.log("[NEWS] limite diário atingido", JSON.stringify({total:Number(daily.total||0)})); return { skipped: "daily_limit", total:Number(daily.total||0) }; }
  console.log("[NEWS] limite diário", JSON.stringify({total:Number(daily.total||0)}));
  const feeds = String(env.RSS_FEEDS || "").split(/\r?\n|;/).map(x => x.trim()).filter(x => /^https?:\/\//i.test(x)).slice(0, 12);
  if (!feeds.length) throw new Error("RSS_FEEDS não configurado");
  console.log("[NEWS] feeds configurados", JSON.stringify({count:feeds.length}));
  const all = await Promise.allSettled(feeds.map(async url => {
    const r = await fetch(url);
    if (!r.ok) throw new Error("Feed HTTP " + r.status);
    const xml = await r.text();
    const entries = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)];
    return entries.map(m => {
      const b = m[2];
      const get = name => {
        const x = b.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + "\\s*>", "i"));
        return x ? x[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").trim() : "";
      };
      const link = get("link") || ((b.match(/<link\b[^>]*href=["']([^"']+)["']/i) || [])[1] || "");
      return { title: get("title"), excerpt: get("description") || get("summary") || get("content"), link, date: get("pubDate") || get("published") || get("updated"), source: new URL(url).hostname.replace(/^www\./, "") };
    }).filter(x => x.title && x.link && /^https?:\/\//i.test(x.link));
  }));
  const items = [];
  for (let i=0;i<all.length;i++) {
    const r=all[i];
    if (r.status === "fulfilled") { items.push(...r.value); console.log("[NEWS] feed consultado", JSON.stringify({index:i+1,items:r.value.length})); }
    else console.error("[NEWS] falha no feed", JSON.stringify({index:i+1,error:String(r.reason)}));
  }
  console.log("[NEWS] total de itens RSS", items.length);
  items.sort((a,b) => (Date.parse(b.date)||0) - (Date.parse(a.date)||0));
  let item = null;
  for (const x of items) {
    const old = await env.DB.prepare("SELECT id FROM articles WHERE source_url = ? LIMIT 1").bind(x.link).first();
    if (!old) { item = x; break; }
  }
  if (!item) { console.log("[NEWS] nenhum artigo novo elegível", JSON.stringify({items:items.length})); return { skipped: "no_new_articles", items:items.length }; }
  console.log("[NEWS] artigo selecionado", JSON.stringify({source:item.source,url:item.link,title:item.title}));
  let pageText = "";
  try {
    const r = await fetch(item.link, { headers: { "User-Agent": "OSeuRadarBot/1.0" } });
    if (r.ok) pageText = (await r.text()).replace(/<(script|style|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").slice(0, 14000);
  } catch (e) { console.warn("Falha ao ler matéria original", String(e)); }
  const prompt = "Você é editor de um veículo jornalístico brasileiro. Produza uma reportagem original em português brasileiro com aproximadamente 800 palavras (faixa desejada: 750 a 850), usando subtítulos <h2> e parágrafos <p>. Desenvolva o assunto com profundidade, sem repetir ideias nem alongar artificialmente. Explique o que aconteceu, o contexto, como a tecnologia ou decisão funciona, impactos concretos, limitações, pontos ainda incertos e o que o leitor brasileiro precisa entender. Acrescente análise e síntese próprias somente quando sustentadas pelas informações fornecidas; diferencie claramente fatos, declarações e análise. Use atribuição clara para dados e declarações e preserve nomes, datas e números. Não invente fontes, citações, estatísticas, testes, especialistas, consequências ou detalhes ausentes. Se o material não sustentar uma reportagem responsável nessa extensão, informe isso em vez de preencher lacunas. Não copie nem faça tradução literal da fonte. Evite introduções genéricas, conclusões repetitivas e adjetivação promocional. Retorne JSON válido com title, excerpt e body (HTML simples).";
  const ai = await fetch(env.AI_API_URL || "https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ model: env.AI_MODEL || "llama-3.3-70b-versatile", temperature: 0.35, max_tokens: 3600, response_format: { type: "json_object" }, messages: [
      { role: "system", content: prompt },
      { role: "user", content: "Fonte: " + item.source + "\nURL: " + item.link + "\nTítulo: " + item.title + "\nResumo RSS: " + item.excerpt + "\nTexto consultado: " + pageText }
    ] })
  });
  console.log("[NEWS] resposta Groq recebida", JSON.stringify({status:ai.status,ok:ai.ok}));
  const raw = await ai.text();
  if (!ai.ok) throw new Error("Groq HTTP " + ai.status + ": " + raw.slice(0, 300));
  const data = JSON.parse(raw);
  const article = JSON.parse(data.choices[0].message.content);
  const plain = String(article.body || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
  const wordCount = plain ? plain.split(/\s+/).length : 0;
  if (!article.title || !article.excerpt || wordCount < 500) throw new Error("Reportagem insuficiente: " + wordCount + " palavras; mínimo de 500. Não gravada.");
  if (wordCount > 1050) console.warn("[NEWS] reportagem acima da faixa editorial", JSON.stringify({wordCount}));
  console.log("[NEWS] extensão editorial validada", JSON.stringify({wordCount}));
  const status = String(env.AUTO_PUBLISH || "false").toLowerCase() === "true" ? "published" : "pending_review";
  const saved = await env.DB.prepare("INSERT INTO articles (category,title,excerpt,body,source_name,source_url,status,created_at,published_at,title_pt,excerpt_pt,body_pt,image_url,video_url) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?,?,?,NULL,NULL)").bind("Inteligência Artificial",article.title,article.excerpt,article.body,item.source,item.link,status,status,article.title,article.excerpt,article.body).run();
  const result = { ok: true, id: saved.meta.last_row_id, title: article.title, status: status };
  console.log("[NEWS] notícia gravada no D1", JSON.stringify(result));
  return result;
}