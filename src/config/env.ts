/**
 * Environment contract.
 *
 * Parsed once, at boot, through a schema — so a missing MONGODB_URI fails on
 * startup with a readable message rather than as a null-pointer three requests
 * later. Everything optional has a working default, which is what lets the API
 * boot on a laptop with nothing configured but the database.
 *
 * FIREBASE_PROJECT_ID is required and FIREBASE_PRIVATE_KEY is deliberately NOT.
 * See shared/auth/verify-token.ts: ID tokens are verified against Google's
 * published public keys, so this service holds no service-account secret at all.
 */
import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  /**
   * Comma-separated allowlist. Render and Vercel each get their own origin, and
   * a preview deployment gets another, so this has to be a list rather than the
   * single value a one-box setup can get away with.
   */
  FRONTEND_URL: z.string().default("http://localhost:3000"),

  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  MONGODB_DB: z.string().default("personal_ledger"),

  /** The Firebase project whose ID tokens this API will accept. */
  FIREBASE_PROJECT_ID: z.string().min(1, "FIREBASE_PROJECT_ID is required"),

  /**
   * Where the RS256 public keys for those tokens are fetched from.
   *
   * Defaults to Google's published certificates, which is what production
   * always wants. It exists as an override so the integration tests can mint
   * real, correctly-signed tokens against a key set they control — otherwise
   * testing "does a bad token get rejected" would need a test-only bypass in the
   * verifier, and a bypass in an authentication path is exactly the sort of
   * thing that outlives the test that justified it.
   */
  FIREBASE_JWKS_URL: z
    .string()
    .default("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),

  /** Receipt OCR. Absent means the scan endpoint reports itself unavailable and
   *  the app falls back to manual entry — a degraded mode, not a broken one. */
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
});

export type Environment = z.infer<typeof envSchema>;

let cached: Environment | undefined;

export function getEnvironment(): Environment {
  if (cached) return cached;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid server environment: ${details}`);
  }

  cached = result.data;
  return cached;
}

/** The CORS allowlist, split and trimmed. */
export function allowedOrigins(): string[] {
  return getEnvironment()
    .FRONTEND_URL.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
