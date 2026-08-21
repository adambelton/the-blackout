/**
 * Replicate client — image generation for broadcast illustrations.
 *
 * Called from the RoomConductor when Kairos's imagery decision returns
 * a `generate` instruction with a prompt. Runs in parallel with the
 * TTS synthesis of the same narrative; whichever finishes first fires
 * its respective cue to the matchroom. Images arrive on screen when
 * ready — never blocking audio playback.
 *
 * **Style vs. subject.** Kairos's imagery selector writes a prompt
 * describing *what* the image should show (scene, mood, light). The
 * *style* is a product-wide constant loaded from
 * `content/illustration-style.md` and prepended here. Kairos doesn't
 * need to know.
 */
import Replicate from "replicate";
import { DEFAULT_ILLUSTRATION_STYLE } from "./defaults.js";

const DEFAULT_MODEL = "black-forest-labs/flux-schnell";

let cached: Replicate | null = null;
function getClient(): Replicate {
  if (cached) return cached;
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new Error(
      "REPLICATE_API_TOKEN is not set — illustration generation unavailable",
    );
  }
  cached = new Replicate({ auth: token });
  return cached;
}

export interface GeneratedImage {
  bytes: Buffer;
  contentType: string;
  model: string;
  generationMs: number;
}

/**
 * Generate a single image from a prompt. Returns the bytes + content
 * type ready to hand to the storage provider. Throws on failure —
 * caller (conductor) is responsible for catching and degrading
 * gracefully (previous image stays, log to telemetry).
 */
export async function generateImage(prompt: string): Promise<GeneratedImage> {
  const client = getClient();
  const model = (process.env.REPLICATE_MODEL ?? DEFAULT_MODEL) as `${string}/${string}`;
  const styledPrompt = `${DEFAULT_ILLUSTRATION_STYLE} ${prompt}`;
  const startedAt = Date.now();

  // Flux Schnell accepts `prompt` and returns image URLs / readable streams.
  // The Replicate SDK resolves either to a URL string or to an object with a
  // `url()` method (newer model responses). Handle both.
  const output = await client.run(model, {
    input: {
      prompt: styledPrompt,
      // Minimal defaults — shared by Schnell + Dev + Pro without
      // hitting model-specific parameter schemas. Inference-step
      // counts differ per model (Schnell: 4, Dev: 28, Pro: N/A), so
      // we don't set it — each model uses its own default.
      aspect_ratio: "4:3",
      output_format: "webp",
      output_quality: 85,
    },
  });

  // The SDK normalizes output to an array (even for single-image models).
  // First element is the image we want.
  const first = Array.isArray(output) ? output[0] : output;
  if (!first) {
    throw new Error(`Replicate returned no output for model ${model}`);
  }

  // Newer model returns a FileOutput object with a `url()` getter that
  // returns a URL string. Older shape is a direct URL string. Handle both.
  let imageUrl: string;
  if (typeof first === "string") {
    imageUrl = first;
  } else if (typeof first === "object" && "url" in first && typeof (first as { url: unknown }).url === "function") {
    imageUrl = String((first as { url: () => URL }).url());
  } else {
    throw new Error(`Replicate returned unexpected output shape for ${model}`);
  }

  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Replicate image fetch failed: ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get("content-type") ?? "image/webp";
  const arrayBuf = await res.arrayBuffer();

  return {
    bytes: Buffer.from(arrayBuf),
    contentType,
    model,
    generationMs: Date.now() - startedAt,
  };
}
