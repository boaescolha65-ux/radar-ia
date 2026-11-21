/* Piper TTS local no navegador — O Seu Radar.
 * Motor Piper via WebAssembly + ONNX Runtime Web.
 * O texto e o áudio permanecem no dispositivo do visitante.
 */
const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/";
const PHONEMIZER_BASE = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/";
const MODEL_URL = "https://huggingface.co/Trelis/piper-pt-br-faber-medium/resolve/main/model.onnx";
const CONFIG_URL = "https://huggingface.co/Trelis/piper-pt-br-faber-medium/resolve/main/model.onnx.json";
const CACHE_NAME = "oseuradar-piper-ptbr-v1";

let runtimePromise = null;
let phonemizerOutput = [];
let queue = Promise.resolve();
const cancelled = new Set();

function progress(id, message) {
  self.postMessage({ type: "progress", id, message });
}

async function fetchModelAsset(url) {
  let cache = null;
  if ("caches" in self) {
    try {
      cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url);
      if (cached) return cached;
    } catch (_) {
      cache = null;
    }
  }

  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) throw new Error("Não foi possível baixar o modelo de voz (HTTP " + response.status + ").");
  if (cache) {
    try { await cache.put(url, response.clone()); } catch (_) {}
  }
  return response;
}

async function importRemoteScript(url) {
  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) throw new Error("Não foi possível carregar uma dependência do Piper (HTTP " + response.status + ").");
  const source = await response.text();
  const objectUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    importScripts(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function initialize(id) {
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    progress(id, "Carregando o motor de voz…");
    await importRemoteScript(ORT_BASE + "ort.wasm.min.js");
    await importRemoteScript(PHONEMIZER_BASE + "piper_phonemize.js");

    if (typeof ort === "undefined" || typeof createPiperPhonemize !== "function") {
      throw new Error("Não foi possível carregar os componentes WebAssembly do Piper.");
    }

    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.wasm.numThreads = 1;

    progress(id, "Baixando a voz neural em português (aprox. 63 MB, somente na primeira vez)…");
    const [modelResponse, configResponse] = await Promise.all([
      fetchModelAsset(MODEL_URL),
      fetchModelAsset(CONFIG_URL)
    ]);
    const [modelBuffer, config] = await Promise.all([
      modelResponse.arrayBuffer(),
      configResponse.json()
    ]);

    progress(id, "Preparando o modelo neural…");
    const session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });

    progress(id, "Preparando a pronúncia em português brasileiro…");
    const phonemizer = await createPiperPhonemize({
      print: line => { if (line) phonemizerOutput.push(line); },
      printErr: message => console.warn("[Piper phonemizer]", message),
      locateFile: file => PHONEMIZER_BASE + file
    });

    return { session, config, phonemizer };
  })().catch(error => {
    runtimePromise = null;
    throw error;
  });

  return runtimePromise;
}

function toWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return buffer;
}

async function synthesizeText(id, text) {
  if (!text || !text.trim()) throw new Error("O texto da notícia está vazio.");
  const engine = await initialize(id);
  if (cancelled.has(id)) throw new DOMException("Geração cancelada.", "AbortError");

  progress(id, "Convertendo texto em fonemas…");
  phonemizerOutput = [];
  const phonemizer = engine.phonemizer;

  try {
    const exitCode = phonemizer.callMain([
      "-l", engine.config.espeak.voice,
      "--input", JSON.stringify([{ text }]),
      "--espeak_data", "/espeak-ng-data"
    ]);
    if (exitCode !== 0) throw new Error("O Piper não conseguiu preparar a pronúncia do texto.");
  } catch (error) {
    throw error;
  }

  let phonemeResult = null;
  for (const line of phonemizerOutput) {
    try { phonemeResult = JSON.parse(line); } catch (_) {}
  }
  if (!phonemeResult || !Array.isArray(phonemeResult.phoneme_ids) || !phonemeResult.phoneme_ids.length) {
    throw new Error("O Piper não retornou fonemas para esta notícia.");
  }

  const config = engine.config;
  const eosValues = config.phoneme_id_map && config.phoneme_id_map["$"];
  if (!eosValues || !eosValues.length) throw new Error("Configuração de voz Piper inválida.");
  const eosId = eosValues[0];
  const sentences = [];
  let current = [];
  for (const phonemeId of phonemeResult.phoneme_ids) {
    current.push(phonemeId);
    if (phonemeId === eosId) {
      if (current.length) sentences.push(current);
      current = [];
    }
  }
  if (current.length) sentences.push(current);
  if (!sentences.length) throw new Error("Não foi possível separar as frases para narração.");

  const sampleRate = config.audio && config.audio.sample_rate || 22050;
  const silence = new Float32Array(Math.round(sampleRate * 0.12));
  const segments = [];
  let sampleCount = 0;

  for (let index = 0; index < sentences.length; index++) {
    if (cancelled.has(id)) throw new DOMException("Geração cancelada.", "AbortError");
    progress(id, "Sintetizando frase " + (index + 1) + " de " + sentences.length + "…");

    const ids = sentences[index];
    const feeds = {
      input: new ort.Tensor("int64", BigInt64Array.from(ids, value => BigInt(value)), [1, ids.length]),
      input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor("float32", Float32Array.from([
        config.inference.noise_scale,
        config.inference.length_scale,
        config.inference.noise_w
      ]), [3])
    };

    const result = await engine.session.run(feeds);
    const pcm = result.output && result.output.data;
    if (!pcm || !pcm.length) throw new Error("O modelo Piper não gerou áudio para uma frase.");
    segments.push(pcm);
    sampleCount += pcm.length;

    if (index < sentences.length - 1) {
      segments.push(silence);
      sampleCount += silence.length;
    }
  }

  if (cancelled.has(id)) throw new DOMException("Geração cancelada.", "AbortError");
  const combined = new Float32Array(sampleCount);
  let offset = 0;
  for (const segment of segments) {
    combined.set(segment, offset);
    offset += segment.length;
  }
  return toWav(combined, sampleRate);
}

self.onmessage = event => {
  const message = event.data || {};
  if (message.type === "cancel") {
    cancelled.add(message.id);
    return;
  }
  if (message.type !== "synthesize") return;

  queue = queue.then(async () => {
    const { id, text } = message;
    try {
      const buffer = await synthesizeText(id, text);
      if (cancelled.has(id)) {
        cancelled.delete(id);
        self.postMessage({ type: "cancelled", id });
        return;
      }
      self.postMessage({ type: "result", id, buffer }, [buffer]);
    } catch (error) {
      self.postMessage({
        type: error && error.name === "AbortError" ? "cancelled" : "error",
        id,
        message: error && error.message ? error.message : "Falha inesperada na síntese Piper."
      });
    } finally {
      cancelled.delete(id);
    }
  });
};
