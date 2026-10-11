/**
 * Receipt OCR contract — required item 1.
 *
 * Every field is nullable and every field carries its own confidence, because
 * the brief requires us to "show what was read so the user can check it, and let
 * them correct any field before saving". A field the model could not read must
 * arrive as null with a reason, not as a confident guess — a wrong amount the
 * user waves through is worse than a blank the user fills in.
 */

export type FieldConfidence = "high" | "medium" | "low";

export interface ExtractedField<T> {
  value: T | null;
  confidence: FieldConfidence;
  /** What the model saw on the receipt, verbatim — shown under the input so the
   *  user can check our reading against the image without zooming in. */
  raw: string | null;
}

export interface ReceiptExtraction {
  /** Canonical 2dp money string, e.g. "1234.50". Never a number. */
  amount: ExtractedField<string>;
  /** "YYYY-MM-DD". */
  date: ExtractedField<string>;
  shop: ExtractedField<string>;
  /** Our category suggestion. Always user-overridable. */
  category: ExtractedField<string>;
  /** Set when the image could not be read at all. */
  error: string | null;
}

export const EMPTY_EXTRACTION: ReceiptExtraction = {
  amount: { value: null, confidence: "low", raw: null },
  date: { value: null, confidence: "low", raw: null },
  shop: { value: null, confidence: "low", raw: null },
  category: { value: null, confidence: "low", raw: null },
  error: null,
};

/**
 * The exact ten categories the sample dataset uses — verified by scanning all 25
 * public cases, not assumed.
 *
 * There is deliberately no "Other" bucket. A scanned receipt MUST land in one of
 * the same categories the dashboard charts, or it becomes invisible in the
 * breakdown and the month-over-month comparison silently under-reports. The OCR
 * prompt therefore asks for the closest match among these, never a new label.
 *
 * Note the dataset says "Food" (not "Dining") and has "Clothing" and "Mobile"
 * as first-class categories — Mobile being phone top-ups, which are a distinct
 * and frequent line item in a Bangladeshi household ledger.
 */
export const CATEGORIES = [
  "Clothing",
  "Education",
  "Entertainment",
  "Food",
  "Groceries",
  "Health",
  "Mobile",
  "Rent",
  "Transport",
  "Utilities",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface OcrPort {
  extract(image: { base64: string; mediaType: string }): Promise<ReceiptExtraction>;
}
