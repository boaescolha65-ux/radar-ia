export async function onRequest(context) {
  const upstream = "https://radar-ia-api.boaescolha65.workers.dev/sitemap.xml";
  try {
    const response = await fetch(upstream, {
      headers: { "Accept": "application/xml, text/xml;q=0.9, */*;q=0.8" }
    });
    const headers = new Headers(response.headers);
    headers.set("Content-Type", "application/xml; charset=utf-8");
    headers.set("Cache-Control", "public, max-age=1800");
    headers.delete("Content-Length");
    return new Response(response.body, {
      status: response.status,
      headers
    });
  } catch (error) {
    return new Response("Falha ao obter sitemap do Worker.", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
    });
  }
}
