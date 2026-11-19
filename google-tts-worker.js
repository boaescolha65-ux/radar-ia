/**
 * O Seu Radar — Google Cloud Text-to-Speech proxy
 * POST /api/tts — Chirp 3 HD, Portuguese (Brazil)
 *
 * Required bindings/secrets:
 *   GOOGLE_SERVICE_ACCOUNT_JSON: complete service-account JSON (Secret)
 *   TTS_KV: Cloudflare KV namespace (cache + basic per-IP limit)
 */
const GOOGLE_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const VOICE = "pt-BR-Chirp3-HD-Aoede";
const MAX_TEXT = 1400;
const DAILY_LIMIT = 40;
const CACHE_TTL = 60 * 60 * 24 * 14;
const ALLOWED_ORIGINS = new Set([
  "https://oseuradar.com.br",
  "https://www.oseuradar.com.br"
]);
let cachedAccessToken = "";
let tokenExpiresAt = 0;

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
function base64url(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function pemToBytes(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(body);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
async function getAccessToken(serviceAccount) {
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60000) return cachedAccessToken;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const unsigned = header + "." + claim;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)
  );
  const assertion = unsigned + "." + base64url(new Uint8Array(signature));
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    console.error("Google OAuth error:", data);
    throw new Error("Não foi possível autenticar no Google Cloud.");
  }
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  return cachedAccessToken;
}
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
async function rateLimit(env, ip) {
  const key = "limit:" + (await sha256(ip || "unknown")).slice(0, 32);
  const current = Number(await env.TTS_KV.get(key) || 0);
  if (current >= DAILY_LIMIT) return false;
  await env.TTS_KV.put(key, String(current + 1), { expirationTtl: 86400 });
  return true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (url.pathname !== "/api/tts") return json({ error: "Not found" }, 404, headers);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, headers);
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed" }, 403, headers);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "JSON inválido." }, 400, headers); }
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "Texto vazio." }, 400, headers);
    if (text.length > MAX_TEXT) return json({ error: "Trecho excede 1.400 caracteres." }, 413, headers);

    if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.TTS_KV) {
      return json({ error: "Configure GOOGLE_SERVICE_ACCOUNT_JSON e TTS_KV no Worker." }, 503, headers);
    }

    const cacheKey = "google-audio:" + await sha256("pt-BR|" + VOICE + "|" + text);
    try {
      const cached = await env.TTS_KV.get(cacheKey, "arrayBuffer");
      if (cached) return new Response(cached, {
        status: 200,
        headers: { ...headers, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400", "X-TTS-Cache": "HIT" }
      });
    } catch (error) {
      console.warn("Cache read failed:", error);
    }

    try {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!(await rateLimit(env, ip))) {
        return json({ error: "Limite diário de 40 trechos por IP atingido. Tente amanhã." }, 429, headers);
      }

      let serviceAccount;
      try { serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON); }
      catch { return json({ error: "A credencial Google configurada não é um JSON válido." }, 500, headers); }
      if (!serviceAccount.client_email || !serviceAccount.private_key) {
        return json({ error: "A credencial Google não contém client_email/private_key." }, 500, headers);
      }

      const accessToken = await getAccessToken(serviceAccount);
      const response = await fetch(GOOGLE_TTS_URL, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + accessToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: "pt-BR", name: VOICE },
          audioConfig: { audioEncoding: "MP3" }
        })
      });
      const result = await response.json();
      if (!response.ok || !result.audioContent) {
        console.error("Google TTS error:", result);
        const message = result?.error?.message || "Google Cloud TTS não retornou áudio.";
        return json({ error: message }, response.status === 429 ? 429 : 502, headers);
      }

      const binary = atob(result.audioContent);
      const audio = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) audio[i] = binary.charCodeAt(i);
      if (!audio.length || audio.length > 4 * 1024 * 1024) {
        return json({ error: "Áudio vazio ou maior que 4 MB." }, 502, headers);
      }

      try {
        await env.TTS_KV.put(cacheKey, audio, { expirationTtl: CACHE_TTL });
      } catch (error) {
        console.warn("Cache write failed:", error);
      }
      return new Response(audio, {
        status: 200,
        headers: { ...headers, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400", "X-TTS-Cache": "MISS" }
      });
    } catch (error) {
      console.error("Google Cloud TTS proxy error:", error);
      return json({ error: "Falha ao gerar áudio no Google Cloud TTS. Verifique API, faturamento e credenciais." }, 502, headers);
    }
  }
};
