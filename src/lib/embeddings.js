import { pipeline } from "@huggingface/transformers";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let extractorPromise;

const progressListeners = new Set();

/**
 * Subscribe to model-download progress.
 *
 * The model is ~25MB and downloads on the first embed call, so without this
 * the first store or search looks like a hung button on a cold profile.
 */
export function onModelProgress(fn) {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

function notifyProgress(state) {
  for (const fn of progressListeners) fn(state);
}

/**
 * transformers.js reports progress per file, so percentages are aggregated
 * across every file in flight rather than reported per file — otherwise the
 * bar restarts at zero each time a new file begins.
 */
const fileProgress = new Map();

function handleProgress(event) {
  if (event.status === "progress" && event.total) {
    fileProgress.set(event.file, { loaded: event.loaded, total: event.total });
    let loaded = 0;
    let total = 0;
    for (const f of fileProgress.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    notifyProgress({
      status: "loading",
      percent: total ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
      loadedBytes: loaded,
      totalBytes: total,
    });
  } else if (event.status === "ready") {
    fileProgress.clear();
    notifyProgress({ status: "ready", percent: 100 });
  }
}

function getExtractor() {
  if (!extractorPromise) {
    notifyProgress({ status: "loading", percent: 0 });
    extractorPromise = pipeline("feature-extraction", MODEL_ID, {
      progress_callback: handleProgress,
    }).then(
      (extractor) => {
        notifyProgress({ status: "ready", percent: 100 });
        return extractor;
      },
      (err) => {
        // Let the next call retry rather than caching a rejected promise.
        extractorPromise = undefined;
        notifyProgress({ status: "error", error: String(err) });
        throw err;
      },
    );
  }
  return extractorPromise;
}

export async function embed(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

/** Dimension of a valid embedding, used to validate imported records. */
export const EMBEDDING_DIMS = 384;

export function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are already L2-normalized, so dot product == cosine similarity
}
