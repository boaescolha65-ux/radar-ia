/**
 * O Seu Radar — Radar Diário
 * Gera roteiro audiovisual exclusivamente com notícias publicadas em TI e IA.
 * Não altera notícias nem publica conteúdo no site.
 */
const ALLOWED_CATEGORIES = ["Tecnologia da Informação", "Inteligência Artificial"];
const countWords = value => String(value || "").trim().split(/\s+/).filter(Boolean).length;
const secondsFor = words => Math.ceil((words / 135) * 60);

export async function generateRadarDailyScript(env) {
  if (!env.DB) throw new Error("D1 DB não configurado.");
  const key = env.AI_API_KEY || env.GROQ_API_KEY || env.GROQ_API_TOKEN;
  if (!key) throw new Error("Configure AI_API_KEY ou GROQ_API_KEY como Secret no Worker.");

  // Incluir os campos traduzidos na consulta: sem eles o roteiro poderia receber
  // títulos e textos no idioma original, apesar de a locução ser solicitada em pt-BR.
  const result = await env.DB.prepare(
    "SELECT id, category, title, excerpt, body, title_pt, excerpt_pt, body_pt, source_name, source_url, published_at, image_url FROM articles WHERE status = 'published' AND category IN (?, ?) ORDER BY published_at DESC, id DESC LIMIT 40"
  ).bind(...ALLOWED_CATEGORIES).all();

  const articles = (result.results || []).map(a => ({
    id: Number(a.id),
    category: a.category,
    title: a.title_pt || a.title || "",
    excerpt: a.excerpt_pt || a.excerpt || "",
    body: String(a.body_pt || a.body || "").slice(0, 6500),
    source_name: a.source_name || "",
    source_url: a.source_url || "",
    published_at: a.published_at || "",
    image_url: a.image_url || ""
  })).filter(a => Number.isInteger(a.id) && a.id > 0 &&
    ALLOWED_CATEGORIES.includes(a.category) && a.title && a.source_url);

  if (articles.length < 4) {
    throw new Error("Há menos de 4 notícias publicadas elegíveis em TI e IA. O Radar Diário não será montado com notícias pendentes ou de outras categorias.");
  }

  const prompt = [
    "Você é o editor-chefe e roteirista do telejornal digital brasileiro O Seu Radar — Radar Diário.",
    "O programa cobre EXCLUSIVAMENTE duas editorias: Tecnologia da Informação e Inteligência Artificial. Não inclua notícias de outras áreas; outros setores só podem aparecer quando o vínculo com TI ou IA for central e explícito.",
    "Escolha de 6 a 8 notícias quando houver material suficiente. Priorize relevância, atualidade, diversidade entre TI e IA, impacto para o público brasileiro e evite assuntos repetidos. Se houver menos de 6 notícias realmente relevantes, use apenas as adequadas; nunca invente pautas.",
    "Monte uma edição de aproximadamente 12 a 15 minutos, com abertura curta, manchetes, notícias, transições e encerramento. Narração em português brasileiro natural, clara, jornalística e envolvente.",
    "Cada notícia deve ter texto original de locução, contexto, explicação do que aconteceu e por que importa. Não leia a reportagem inteira. Não invente fatos, datas, números, citações ou fontes. Diferencie fatos de análise.",
    "Distribua as notícias entre TI e IA conforme a relevância real, sem divisão artificial de 50/50. Cada matéria deve durar aproximadamente 1 a 2 minutos; matérias especiais podem ser maiores quando justificadas.",
    'Retorne SOMENTE JSON válido no formato: {"program_title":"...","edition_date":"YYYY-MM-DD","opening":"...","headlines":[{"article_id":123,"category":"...","headline":"...","teaser":"..."}],"stories":[{"article_id":123,"category":"...","headline":"...","narration":"...","duration_seconds":90}],"closing":"...","editorial_notes":["..."]}.',
    "Use apenas article_id existentes na lista. Não repita article_id. Cada story deve corresponder a uma notícia da lista. Escreva a locução com extensão compatível com 130 a 145 palavras por minuto. Não estime duração arbitrariamente.",
    "Data de referência: " + new Date().toISOString().slice(0, 10) + "."
  ].join("\n");

  const response = await fetch(env.AI_API_URL || "https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.AI_MODEL || "openai/gpt-oss-120b",
      temperature: 0.25,
      max_tokens: 6500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: "Notícias candidatas (todas publicadas e já aprovadas no D1):\n" + JSON.stringify(articles) }
      ]
    })
  });

  const raw = await response.text();
  if (!response.ok) throw new Error("Falha na geração do roteiro (Groq HTTP " + response.status + "): " + raw.slice(0, 300));
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error("Resposta inválida do serviço de IA."); }
  let script;
  try { script = JSON.parse(data.choices?.[0]?.message?.content || "{}"); } catch { throw new Error("O serviço de IA não retornou um roteiro JSON válido."); }

  const byId = new Map(articles.map(a => [a.id, a]));
  if (!Array.isArray(script.stories)) throw new Error("Roteiro sem lista de notícias.");
  const usedIds = new Set();
  script.stories = script.stories.filter(story => {
    const id = Number(story.article_id);
    const original = byId.get(id);
    if (!original || usedIds.has(id) || !ALLOWED_CATEGORIES.includes(original.category)) return false;
    if (typeof story.narration !== "string" || countWords(story.narration) < 80) return false;
    usedIds.add(id);
    story.article_id = original.id;
    story.category = original.category;
    story.headline = String(story.headline || original.title).slice(0, 180);
    story.source_name = original.source_name;
    story.source_url = original.source_url;
    story.image_url = original.image_url;
    // Duração calculada a partir do texto real, não do número fornecido pelo modelo.
    story.duration_seconds = secondsFor(countWords(story.narration));
    return true;
  });

  if (script.stories.length < 4 || script.stories.length > 8) {
    throw new Error("A seleção final não passou na validação editorial (mínimo 4 e máximo 8 notícias únicas). Gere novamente ou revise as notícias publicadas.");
  }

  // Manchetes só podem apontar para matérias efetivamente selecionadas.
  const storyIds = new Set(script.stories.map(s => s.article_id));
  script.headlines = Array.isArray(script.headlines) ? script.headlines.filter(h =>
    storyIds.has(Number(h.article_id))
  ).map(h => {
    const story = script.stories.find(s => s.article_id === Number(h.article_id));
    return { article_id: story.article_id, category: story.category,
      headline: story.headline, teaser: String(h.teaser || "").slice(0, 300) };
  }) : [];

  const spokenWords = countWords(script.opening) +
    countWords(script.closing) +
    countWords(script.headlines.map(h => h.headline + " " + h.teaser).join(" ")) +
    script.stories.reduce((sum, s) => sum + countWords(s.narration), 0);
  const transitionsSeconds = script.stories.length * 12;
  script.program_title = "O Seu Radar — Radar Diário";
  script.edition_date = new Date().toISOString().slice(0, 10);
  script.editorial_scope = ALLOWED_CATEGORIES;
  script.generated_at = new Date().toISOString();
  script.estimated_duration_seconds = secondsFor(spokenWords) + transitionsSeconds;
  script.source_article_ids = script.stories.map(s => s.article_id);
  return script;
}
