/**
 * O Seu Radar — Worker de narração TTS
 * Endpoint POST /api/tts
 * Cloudflare Workers AI: xai/grok-tts (pt-BR)
 */
const MODEL = "xai/grok-tts";
const MAX_TEXT = 1400;
const DAILY_LIMIT = 40;
const CACHE_TTL = 60 * 60 * 24 * 14;
const ALLOWED_ORIGINS = new Set([
  "https://oseuradar.com.br",
  "https://www.oseuradar.com.br"
]);

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "https://oseuradar.com.br";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}

async function checkRateLimit(env, ip) {
  if (!env.TTS_KV) return { allowed: false, setupError: true };
  const key = "limit:" + (await sha256(ip || "unknown")).slice(0, 32);
  const current = Number(await env.TTS_KV.get(key) || 0);
  if (current >= DAILY_LIMIT) return { allowed: false };
  await env.TTS_KV.put(key, String(current + 1), { expirationTtl: 86400 });
  return { allowed: true };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    if (url.pathname !== "/api/tts") return json({ error: "Not found" }, 404, headers);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, headers);
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed" }, 403, headers);

    let body;
    try { body = await request.json(); } catch { return json({ error: "JSON inválido" }, 400, headers); }
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "Texto vazio" }, 400, headers);
    if (text.length > MAX_TEXT) return json({ error: "Trecho muito longo; limite de 1.400 caracteres" }, 413, headers);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const limit = await checkRateLimit(env, ip);
    if (limit.setupError) return json({ error: "Serviço ainda não configurado: binding TTS_KV ausente." }, 503, headers);
    if (!limit.allowed) return json({ error: "Limite diário de narração atingido. Tente novamente amanhã." }, 429, headers);

    const cacheKey = "audio:" + await sha256("pt-BR|ara|" + text);
    const cached = await env.TTS_KV.get(cacheKey, "arrayBuffer");
    if (cached) {
      return new Response(cached, { status: 200, headers: {
        ...headers, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400",
        "X-TTS-Cache": "HIT"
      }});
    }

    try {
      const result = await env.AI.run(MODEL, {
        text,
        language: "pt-BR",
        voice_id: "ara",
        output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 128000 }
      });
      const audioUrl = result?.result?.audio || result?.audio;
      if (typeof audioUrl !== "string" || !/^https:\/\//.test(audioUrl)) {
        return json({ error: "O modelo não retornou uma URL de áudio válida." }, 502, headers);
      }
      const audioResponse = await fetch(audioUrl);
      if (!audioResponse.ok) return json({ error: "Falha ao obter áudio gerado." }, 502, headers);
      const audio = await audioResponse.arrayBuffer();
      if (!audio.byteLength || audio.byteLength > 4 * 1024 * 1024) {
        return json({ error: "Arquivo de áudio vazio ou excede o limite." }, 502, headers);
      }
      // Guarda o MP3 para reutilização, evitando cobrar nova geração para o mesmo trecho.
      await env.TTS_KV.put(cacheKey, audio, { expirationTtl: CACHE_TTL });
      return new Response(audio, { status: 200, headers: {
        ...headers, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400",
        "X-TTS-Cache": "MISS"
      }});
    } catch (error) {
      console.error("Erro no TTS:", error);
      return json({ error: "Não foi possível gerar a narração neste momento." }, 502, headers);
    }
  }
};
