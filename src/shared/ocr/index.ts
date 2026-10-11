/**
 * Provider selection for receipt OCR.
 *
 * Behind a port, so the vision vendor is one file rather than a dependency
 * threaded through the route. When no key is configured this returns null and
 * every caller must degrade — required item 1 is still met by manual entry, so
 * a missing key is a reduced feature, never a broken page.
 */
import type { OcrPort } from "./types.js";

export type OcrProvider = "anthropic" | "none";

export function activeProvider(): OcrProvider {
  return process.env["ANTHROPIC_API_KEY"] ? "anthropic" : "none";
}

/** Null when nothing is configured. Callers must degrade, not throw. */
export async function getOcr(): Promise<OcrPort | null> {
  if (activeProvider() !== "anthropic") return null;
  const { ClaudeVisionOcr } = await import("./claude-vision.js");
  return new ClaudeVisionOcr();
}
