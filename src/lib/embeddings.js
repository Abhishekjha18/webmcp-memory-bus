import { pipeline } from "@huggingface/transformers";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let extractorPromise;

function getExtractor(onProgress) {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL_ID, {
      progress_callback: onProgress,
    });
  }
  return extractorPromise;
}

export async function embed(text, onProgress) {
  const extractor = await getExtractor(onProgress);
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are already L2-normalized, so dot product == cosine similarity
}
