export async function runNewsGeneration(env) {
  console.log("[NEWS] início da geração", new Date().toISOString());
  if (!env.DB) throw new Error("D1 DB não configurado");
  const key = env.AI_API_KEY || env.GROQ_API_KEY || env.GROQ_API_TOKEN;
  if (!key) throw new Error("Configure AI_API_KEY ou GROQ_API_KEY como Secret no Worker");
  const daily = await env.DB.prepare("SELECT COUNT(*) AS total FROM articles WHERE created_at >= datetime('now','start of day')").first();
  if (Number(daily.total || 0) >= 100) { console.log("[NEWS] limite diário de 100 notícias atingido", JSON.stringify({total:Number(daily.total||0)})); return { skipped: "daily_limit", total:Number(daily.total||0) }; }
  const dailyTotal = Number(daily.total || 0);
  const batchSize = Math.min(2, 100 - dailyTotal);
  console.log("[NEWS] limite diário da fase 3", JSON.stringify({total:dailyTotal, batchSize, dailyCap:100, maxPerRun:2}));
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
      const imageTags = [...b.matchAll(/<(media:thumbnail|media:content|enclosure)\b[^>]*>/gi)].map(m=>m[0]);
      const imageCandidates = imageTags.map(tag => {
        const urlMatch = tag.match(/\burl=["']([^"']+)["']/i);
        const typeMatch = tag.match(/\btype=["']([^"']+)["']/i);
        const mediumMatch = tag.match(/\bmedium=["']([^"']+)["']/i);
        if (!urlMatch) return "";
        if (/media:content/i.test(tag) && (typeMatch || mediumMatch) && !/image/i.test((typeMatch?.[1] || mediumMatch?.[1] || ""))) return "";
        if (/enclosure/i.test(tag) && typeMatch && !/image/i.test(typeMatch[1])) return "";
        return urlMatch[1];
      }).filter(Boolean);
      const inlineImg = b.match(/<img\b[^>]*src=["']([^"']+)["']/i);
      if (inlineImg) imageCandidates.push(inlineImg[1]);
      return { title: get("title"), excerpt: get("description") || get("summary") || get("content"), link, date: get("pubDate") || get("published") || get("updated"), image: imageCandidates[0] || "", source: new URL(url).hostname.replace(/^www\./, "") };
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
  const results = [];
  for (let batch = 0; batch < batchSize; batch++) {
  let item = null;
  for (const x of items) {
    const old = await env.DB.prepare("SELECT id FROM articles WHERE source_url = ? LIMIT 1").bind(x.link).first();
    if (!old) { item = x; break; }
  }
  if (!item) { console.log("[NEWS] nenhum artigo novo elegível", JSON.stringify({items:items.length, batch})); break; }
  console.log("[NEWS] artigo selecionado", JSON.stringify({source:item.source,url:item.link,title:item.title}));
  let pageText = "";
  let imageUrl = item.image || "";
  try {
    const r = await fetch(item.link, { headers: { "User-Agent": "OSeuRadarBot/1.0" } });
    if (r.ok) {
      const html = await r.text();
      if (!imageUrl) {
        const metaTags = [...html.matchAll(/<meta\b[^>]*>/gi)].map(x => x[0]);
        for (const tag of metaTags) {
          const key = (tag.match(/\b(?:property|name)=["']([^"']+)["']/i) || [])[1] || "";
          if (/^(og:image|og:image:url|twitter:image|twitter:image:src)$/i.test(key)) {
            const match = tag.match(/\bcontent=["']([^"']+)["']/i);
            if (match) { try { imageUrl = new URL(match[1], item.link).href; } catch (_) {} }
            if (imageUrl) break;
          }
        }
      }
      if (!imageUrl) {
        const scripts = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
        const findImage = obj => {
          if (!obj || typeof obj !== "object") return "";
          if (Array.isArray(obj)) { for (const child of obj) { const found=findImage(child); if(found)return found; } return ""; }
          const direct=obj.image || obj.thumbnailUrl || obj.primaryImageOfPage;
          if (typeof direct === "string") return direct;
          if (Array.isArray(direct)) return direct.find(x=>typeof x==="string") || "";
          if (direct && typeof direct === "object") return direct.url || direct.contentUrl || "";
          if (obj["@graph"]) return findImage(obj["@graph"]);
          return "";
        };
        for (const script of scripts) {
          try { const found=findImage(JSON.parse(script[1].trim())); if(found){imageUrl=new URL(found,item.link).href;break;} } catch (_) {}
        }
      }
      if (!imageUrl) {
        for (const tag of [...html.matchAll(/<img\b[^>]*>/gi)].map(m=>m[0])) {
          const src=tag.match(/\b(?:src|data-src|data-original)=["']([^"']+)["']/i);
          if(src && !/(logo|icon|avatar|pixel|tracking)/i.test(src[1])) { try { imageUrl=new URL(src[1],item.link).href;break; } catch (_) {} }
        }
      }
      pageText = html.replace(/<(script|style|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").slice(0, 14000);
    }
  } catch (e) { console.warn("Falha ao ler matéria original", String(e)); }
  try { if (imageUrl) imageUrl = new URL(imageUrl, item.link).href; } catch (_) { imageUrl = ""; }
  if (!(imageUrl.startsWith("http://") || imageUrl.startsWith("https://"))) imageUrl = "";
  console.log("[NEWS] imagem da fonte", JSON.stringify({found:!!imageUrl,url:imageUrl || null}));
  const prompt = "Você é editor de um veículo jornalístico brasileiro. Produza uma reportagem original em português brasileiro com aproximadamente 800 palavras (faixa desejada: 750 a 850), O título principal da notícia deve ser fornecido exclusivamente no campo JSON title, pois o site já o exibe automaticamente como H1. Não repita o título principal no campo body e nunca use H1 dentro do body. No body, use Markdown simples para subtítulos: uma linha iniciada por # representa H2; duas cerquilhas representam H3; três cerquilhas representam H4. Portanto, o primeiro nível de título dentro do texto é sempre H2, nunca H1. Escreva os parágrafos como texto normal, separados por uma linha em branco. Não escreva tags HTML (<h1>, <h2>, <h3>, <h4>, <p> etc.) nem mostre os marcadores Markdown como texto literal no resultado renderizado. Desenvolva o assunto com profundidade, sem repetir ideias nem alongar artificialmente. Explique o que aconteceu, o contexto, como a tecnologia ou decisão funciona, impactos concretos, limitações, pontos ainda incertos e o que o leitor brasileiro precisa entender. Acrescente análise e síntese próprias somente quando sustentadas pelas informações fornecidas; diferencie claramente fatos, declarações e análise. Use atribuição clara para dados e declarações e preserve nomes, datas e números. Não invente fontes, citações, estatísticas, testes, especialistas, consequências ou detalhes ausentes. Se o material não sustentar uma reportagem responsável nessa extensão, informe isso em vez de preencher lacunas. Não copie nem faça tradução literal da fonte. Evite introduções genéricas, conclusões repetitivas e adjetivação promocional. Classifique cada notícia em exatamente uma categoria: Inteligência Artificial quando o assunto central for IA generativa, modelos de linguagem, aprendizado de máquina, robótica inteligente ou aplicações diretamente baseadas em IA; Tecnologia da Informação para os demais assuntos de tecnologia, como software, aplicativos, dispositivos, hardware, chips, cibersegurança, telecomunicações, internet, infraestrutura, startups e serviços digitais. Não classifique como IA apenas porque a notícia menciona IA incidentalmente. Retorne JSON válido com category, title, excerpt e body em Markdown simples, e category deve conter exatamente Inteligência Artificial ou Tecnologia da Informação.";
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
  const rawCategory = String(article.category || "").trim().toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
  let category;
  if (/^(inteligencia artificial|ia|artificial intelligence|ai)$/.test(rawCategory)) {
    category = "Inteligência Artificial";
  } else if (/^(tecnologia da informacao|tecnologia|ti|tech|technology|information technology)$/.test(rawCategory)) {
    category = "Tecnologia da Informação";
  } else {
    const classificationText = [item.title, item.excerpt, pageText, article.title, article.excerpt, article.body].join(" ").toLowerCase();
    const aiSignals = /\\b(intelig[eê]ncia artificial|intelig[eê]ncias artificiais|ia generativa|generative ai|artificial intelligence|machine learning|aprendizado de m[aá]quina|deep learning|modelo de linguagem|large language model|\\bllm\\b|chatgpt|gemini|claude|gpt[-\\s]?\\d|copilot|agente de ia|ai agent)\\b/i;
    category = aiSignals.test(classificationText) ? "Inteligência Artificial" : "Tecnologia da Informação";
  }
  const plain = String(article.body || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
  const wordCount = plain ? plain.split(/\s+/).length : 0;
  if (!article.title || !article.excerpt || wordCount < 500) throw new Error("Reportagem insuficiente: " + wordCount + " palavras; mínimo de 500. Não gravada.");
  if (wordCount > 1050) console.warn("[NEWS] reportagem acima da faixa editorial", JSON.stringify({wordCount}));
  console.log("[NEWS] extensão editorial validada", JSON.stringify({wordCount}));
  const status = String(env.AUTO_PUBLISH || "false").toLowerCase() === "true" ? "published" : "pending_review";
  const saved = await env.DB.prepare("INSERT INTO articles (category,title,excerpt,body,source_name,source_url,status,created_at,published_at,title_pt,excerpt_pt,body_pt,image_url,video_url) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?,?,?,?,NULL)").bind(category,article.title,article.excerpt,article.body,item.source,item.link,status,article.title,article.excerpt,article.body,imageUrl || null).run();
  const result = { ok: true, id: saved.meta.last_row_id, title: article.title, status: status };
  results.push(result);
  console.log("[NEWS] notícia gravada no D1", JSON.stringify({batch:batch+1, result}));
  }
  console.log("[NEWS] lote concluído", JSON.stringify({generated:results.length, batchSize}));
  return { ok: results.length > 0, generated: results.length, results };
}