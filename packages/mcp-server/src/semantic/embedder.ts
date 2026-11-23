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

// Deterministic L2-normalized vectors so test/CI cosine similarity is reproducible without API keys.
export function createFakeEmbedder(dimensions = 1536): Embedder {
  return {
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const random = mulberry32(fnv1a(text));
        const vector = Array.from(
          { length: dimensions },
          () => random() * 2 - 1,
        );
        const norm = Math.sqrt(
          vector.reduce((sum, value) => sum + value * value, 0),
        );
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

export function createOpenAIEmbedder(
  options: OpenAIEmbedderOptions = {},
): Embedder {
  const model = options.model ?? process.env["EMBEDDING_MODEL_ID"];
  const baseURL =
    options.baseURL ??
    process.env["EMBEDDING_BASE_URL"] ??
    process.env["OPENAI_COMPATIBLE_BASE_URL"];
  const apiKey = options.apiKey ?? process.env["EMBEDDING_API_KEY"];
  if (!model || !baseURL || !apiKey) {
    throw new Error(
      "embedder needs EMBEDDING_MODEL_ID, EMBEDDING_API_KEY and EMBEDDING_BASE_URL (or OPENAI_COMPATIBLE_BASE_URL fallback)",
    );
  }
  const client = new OpenAI({ baseURL, apiKey });
  const dimensions =
    options.dimensions ?? Number(process.env["EMBEDDING_DIM"] ?? 1536);
  return {
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      const response = await client.embeddings.create({
        model,
        input: texts,
        dimensions,
      });
      return response.data.map((entry) => entry.embedding);
    },
  };
}

export interface EmbedderSelection {
  embedder: Embedder;
  model: string;
}

export function selectEmbedderFromEnv(): EmbedderSelection {
  const configuredModel = process.env["EMBEDDING_MODEL_ID"];
  if (configuredModel && process.env["EMBEDDING_API_KEY"]) {
    const embedder = createOpenAIEmbedder();
    return { embedder, model: configuredModel };
  }
  return { embedder: createFakeEmbedder(), model: "fake" };
}
