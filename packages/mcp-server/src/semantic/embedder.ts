// Embedding providers (MCP-02, D-12, D-17): a shared Embedder interface
// returning fixed-dim vectors, an OpenAI-compatible implementation for the
// operator endpoint, and a deterministic seeded-hash fake (1536-dim,
// L2-normalized) used by every test and CI run so no key is ever needed.
import OpenAI from "openai";

export interface Embedder {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic fake: seeded hashing (FNV-1a over the text, mulberry32
// expansion) mapped to [-1, 1] and L2-normalized, so cosine similarity is
// meaningful and repeat calls are byte-identical.
export function createFakeEmbedder(dimensions = 1536): Embedder {
  return {
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const random = mulberry32(fnv1a(text));
        const vector = Array.from({ length: dimensions }, () => random() * 2 - 1);
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        if (norm === 0) return vector;
        return vector.map((value) => value / norm);
      });
    },
  };
}

export interface OpenAIEmbedderOptions {
  model?: string;
  baseURL?: string;
  apiKey?: string;
  dimensions?: number;
}

export function createOpenAIEmbedder(options: OpenAIEmbedderOptions = {}): Embedder {
  const model = options.model ?? process.env["EMBEDDING_MODEL_ID"];
  const baseURL = options.baseURL ?? process.env["OPENAI_COMPATIBLE_BASE_URL"];
  const apiKey = options.apiKey ?? process.env["EMBEDDING_API_KEY"];
  if (!model || !baseURL || !apiKey) {
    throw new Error(
      "OpenAI embedder needs EMBEDDING_MODEL_ID, OPENAI_COMPATIBLE_BASE_URL and EMBEDDING_API_KEY",
    );
  }
  const client = new OpenAI({ baseURL, apiKey });
  const dimensions = options.dimensions ?? Number(process.env["EMBEDDING_DIM"] ?? 1536);
  return {
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      const response = await client.embeddings.create({ model, input: texts });
      return response.data.map((entry) => entry.embedding);
    },
  };
}

// Operator selection: the OpenAI-compatible endpoint when a model and key
// are configured, otherwise the deterministic fake (with a boot warning so
// fake embeddings in production are always a conscious choice).
export function selectEmbedderFromEnv(): { embedder: Embedder; source: "openai" | "fake" } {
  if (
    process.env["EMBEDDING_MODEL_ID"] &&
    process.env["EMBEDDING_API_KEY"]
  ) {
    return { embedder: createOpenAIEmbedder(), source: "openai" };
  }
  return { embedder: createFakeEmbedder(), source: "fake" };
}
