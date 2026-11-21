/* Ponte entre o player existente e o Worker Piper local. */
(() => {
  const pending = new Map();
  let nextId = 0;
  let worker = null;
  let workerError = null;

  function getWorker() {
    if (workerError) throw workerError;
    if (!worker) {
      if (typeof Worker === "undefined") throw new Error("Este navegador não oferece suporte ao processamento local de áudio.");
      worker = new Worker("/assets/piper-local-tts-worker.js");
      worker.onmessage = event => {
        const data = event.data || {};
        const request = pending.get(data.id);
        if (!request) return;

        if (data.type === "progress") {
          request.onProgress?.(data.message);
          return;
        }

        pending.delete(data.id);
        if (request.signal && request.abortHandler) {
          request.signal.removeEventListener("abort", request.abortHandler);
        }

        if (data.type === "result") {
          request.resolve(new Blob([data.buffer], { type: "audio/wav" }));
        } else if (data.type === "cancelled") {
          request.reject(new DOMException("Geração cancelada.", "AbortError"));
        } else {
          request.reject(new Error(data.message || "Não foi possível gerar a narração."));
        }
      };
      worker.onerror = event => {
        workerError = new Error("O mecanismo local de áudio falhou ao iniciar. Atualize a página e tente novamente.");
        for (const request of pending.values()) request.reject(workerError);
        pending.clear();
        worker?.terminate();
        worker = null;
      };
    }
    return worker;
  }

  window.PiperLocalTTS = {
    synthesize(text, { signal, onProgress } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Geração cancelada.", "AbortError"));
          return;
        }

        let activeWorker;
        try {
          activeWorker = getWorker();
        } catch (error) {
          reject(error);
          return;
        }

        const id = ++nextId;
        const abortHandler = () => {
          activeWorker.postMessage({ type: "cancel", id });
          const request = pending.get(id);
          if (request) {
            pending.delete(id);
            reject(new DOMException("Geração cancelada.", "AbortError"));
          }
        };

        pending.set(id, { resolve, reject, onProgress, signal, abortHandler });
        signal?.addEventListener("abort", abortHandler, { once: true });
        activeWorker.postMessage({ type: "synthesize", id, text: String(text || "") });
      });
    }
  };
})();
