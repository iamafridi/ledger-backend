/**
 * Receipt reading via Claude vision — one implementation of OcrPort.
 *
 * The prompt, JSON schema and validation are shared with the OpenAI adapter via
 * ./prompt.ts so the two providers cannot drift apart.
 */
import Anthropic from "@anthropic-ai/sdk";
import { EMPTY_EXTRACTION, type OcrPort, type ReceiptExtraction } from "./types.js";
import {
  OCR_JSON_SCHEMA,
  OCR_SYSTEM_PROMPT,
  RawExtractionSchema,
  toReceiptExtraction,
} from "./prompt.js";

const MODEL = "claude-opus-5";

export class ClaudeVisionOcr implements OcrPort {
  private client: Anthropic;

  constructor(client?: Anthropic) {
    // Zero-arg construction resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
    // or an `ant auth login` profile — see the SDK's credential chain.
    this.client = client ?? new Anthropic();
  }

  async extract(image: { base64: string; mediaType: string }): Promise<ReceiptExtraction> {
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: OCR_SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: OCR_JSON_SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: image.mediaType as "image/jpeg",
                data: image.base64,
              },
            },
            { type: "text", text: "Read this receipt." },
          ],
        },
      ],
    } as Anthropic.MessageCreateParamsNonStreaming);

    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      return { ...EMPTY_EXTRACTION, error: "The model returned no readable response." };
    }

    const parsed = RawExtractionSchema.safeParse(JSON.parse(text.text));
    if (!parsed.success) {
      return {
        ...EMPTY_EXTRACTION,
        error: "The model's response did not match the expected shape.",
      };
    }

    return toReceiptExtraction(parsed.data);
  }
}
