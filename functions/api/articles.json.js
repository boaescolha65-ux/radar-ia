// Proxy same-origin para a API pública do Worker. Evita CORS nas prévias por branch do Pages.
// Não lê nem altera secrets, variáveis ou bindings do Worker.
export async function onRequest({ request }) {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json; charset=utf-8", "Allow": "GET" }
    });
  }

  const incoming = new URL(request.url);
  const upstream = new URL("https://radar-ia-api.boaescolha65.workers.dev/api/articles.json");
  upstream.search = incoming.search;

  try {
    const response = await fetch(upstream.toString(), {
      method: "GET",
      headers: { "Accept": "application/json" },
      redirect: "follow"
    });
    const headers = new Headers();
    headers.set("Content-Type", response.headers.get("Content-Type") || "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    console.error("Falha no proxy da API de notícias:", error);
    return new Response(JSON.stringify({ error: "Não foi possível consultar o serviço de publicações." }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
    });
  }
}
