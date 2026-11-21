// Configuração pública do mecanismo Piper executado no navegador.
const CONFIG = {
  engine: "piper-browser",
  voice: "pt_BR-faber-medium",
  modelUrl: "https://huggingface.co/Trelis/piper-pt-br-faber-medium/resolve/main/model.onnx",
  configUrl: "https://huggingface.co/Trelis/piper-pt-br-faber-medium/resolve/main/model.onnx.json",
  ortBase: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/",
  phonemizerBase: "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/",
  cacheName: "oseuradar-piper-ptbr-v1"
};

export async function onRequest({ request }) {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json; charset=utf-8", "Allow": "GET", "Cache-Control": "no-store" }
    });
  }

  return new Response(JSON.stringify(CONFIG), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-TTS-Engine": "piper-browser"
    }
  });
}
