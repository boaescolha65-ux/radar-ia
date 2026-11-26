/**
 * O Seu Radar — Worker isolado para homologação do Piper TTS.
 * Não consulta nem altera D1, não executa cron e não expõe rotas do Worker de produção.
 */
const MAX_TEXT = 1400;
const ALLOWED_ORIGINS = new Set([
  "https://oseuradar.com.br",
  "https://www.oseuradar.com.br",
  "https://radar-ia-2o2.pages.dev",
  "https://radar-ia-page.pages.dev"
]);

function headers(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "https://oseuradar.com.br";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  };
}
function json(data, status, h) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...h, "Content-Type": "application/json; charset=utf-8" }
  });
}
function authorized(request, env) {
  return Boolean(env.ADMIN_TOKEN) &&
    request.headers.get("Authorization") === "Bearer " + env.ADMIN_TOKEN;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const h = headers(origin);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed" }, 403, h);
    if (!url.pathname.startsWith("/admin/radar-daily/")) return json({ error: "Not found" }, 404, h);
    if (!authorized(request, env)) return json({ error: "Token administrativo inválido ou ADMIN_TOKEN ausente." }, 401, h);

    if (url.pathname === "/admin/radar-daily/audio-health" && request.method === "POST") {
      try {
        const response = await fetch("https://radar-ia-1.onrender.com/health", {
          headers: { "Accept": "application/json" },
          signal: AbortSignal.timeout(20000)
        });
        const raw = await response.text();
        let service = {};
        try { service = JSON.parse(raw); } catch {}
        return json({
          ok: response.ok,
          service_status: response.status,
          model_loaded: service.model_loaded ?? null,
          piper_key_configured: Boolean(env.PIPER_API_KEY),
          service
        }, response.ok ? 200 : 502, h);
      } catch (error) {
        return json({
          ok: false,
          piper_key_configured: Boolean(env.PIPER_API_KEY),
          error: "Falha ao consultar Piper: " + String(error).slice(0, 180)
        }, 502, h);
      }
    }

    if (url.pathname === "/admin/radar-daily/audio" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch {
        return json({ error: "JSON inválido." }, 400, h);
      }
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!text) return json({ error: "Texto vazio." }, 400, h);
      if (text.length > MAX_TEXT) return json({ error: "Trecho excede 1.400 caracteres." }, 413, h);
      if (!env.PIPER_API_KEY) return json({ error: "PIPER_API_KEY não configurada no Worker de homologação." }, 503, h);

      try {
        const response = await fetch("https://radar-ia-1.onrender.com/api/tts", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + env.PIPER_API_KEY,
            "Content-Type": "application/json",
            "Accept": "audio/wav"
          },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(90000)
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          return json({ error: "Piper respondeu HTTP " + response.status + ": " + detail.slice(0, 180) }, 502, h);
        }
        const contentType = response.headers.get("Content-Type") || "";
        const audio = await response.arrayBuffer();
        if (!contentType.toLowerCase().includes("audio/wav") || audio.byteLength < 44 || audio.byteLength > 4 * 1024 * 1024) {
          return json({ error: "Piper retornou WAV inválido ou acima do limite." }, 502, h);
        }
        return new Response(audio, {
          status: 200,
          headers: {
            ...h,
            "Content-Type": "audio/wav",
            "Content-Disposition": "attachment; filename=radar-diario-teste.wav"
          }
        });
      } catch (error) {
        return json({ error: "Falha na síntese: " + String(error?.message || error).slice(0, 220) }, 502, h);
      }
    }
    return json({ error: "Rota não encontrada ou método não permitido." }, 404, h);
  }
};
