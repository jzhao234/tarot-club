// Embedder abstracts sentence embedding so the routing logic can be unit-tested
// with a deterministic fake, while production uses the real model.
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

// TransformersEmbedder runs all-MiniLM-L6-v2 SERVER-SIDE via
// transformers.js. The pipeline is lazily loaded once (it downloads + caches
// the ~22MB quantized ONNX model on first use) and reused for every call.
// Output is mean-pooled and L2-normalized, so cosine similarity == dot product.
export class TransformersEmbedder implements Embedder {
  // The transformers.js pipeline is loosely typed here to avoid leaking its
  // internal types through our interface.
  private pipe: Promise<unknown> | null = null;

  constructor(private readonly model = "Xenova/all-MiniLM-L6-v2") {}

  private load(): Promise<unknown> {
    if (!this.pipe) {
      this.pipe = import("@huggingface/transformers").then((t) =>
        t.pipeline("feature-extraction", this.model),
      );
    }
    return this.pipe;
  }

  async embed(text: string): Promise<number[]> {
    const extractor = (await this.load()) as (
      t: string,
      o: { pooling: "mean"; normalize: boolean },
    ) => Promise<{ data: Float32Array | number[] }>;
    const out = await extractor(text, { pooling: "mean", normalize: true });
    return Array.from(out.data);
  }
}
