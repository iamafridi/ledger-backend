/**
 * Server-side verification of Firebase ID tokens.
 *
 * WHY NOT THE ADMIN SDK: firebase-admin needs a service-account private key.
 * That is a real secret, it has to live in the environment of every deploy, and
 * the submission rules forbid committing one — so every path that touches it is
 * a chance to leak it. Firebase ID tokens are ordinary RS256 JWTs signed by
 * Google, whose public certificates are published. Verifying against those
 * certificates needs no secret at all, which removes the leak risk entirely and
 * takes one required environment variable off the deployment checklist.
 *
 * What must be checked, and is:
 *   - signature, against Google's published public keys
 *   - `iss` is https://securetoken.google.com/<project-id>
 *   - `aud` is <project-id>
 *   - `exp` / `iat`, handled by jose
 *   - `sub` is present and non-empty — it becomes the per-user partition key
 *
 * Skipping the audience check is the classic mistake: a valid Google-signed
 * token minted for a DIFFERENT Firebase project would otherwise be accepted,
 * and anyone can create a Firebase project.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

import { getEnvironment } from "../../config/env.js";

const GOOGLE_CERT_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

// Module scope, so the key set is fetched once and shared across requests.
// jose handles caching, refresh and key rotation.
//
// The URL is read from the environment (defaulting to Google's) rather than
// baked in, which is what lets the test suite sign its own tokens instead of
// the verifier carrying a test-only escape hatch. See config/env.ts.
let jwks = createRemoteJWKSet(new URL(GOOGLE_CERT_URL));
let jwksUrl = GOOGLE_CERT_URL;

/** Re-point the key set. Called once, before the first token is verified. */
function useJwksUrl(url: string): void {
  if (url === jwksUrl) return;
  jwksUrl = url;
  jwks = createRemoteJWKSet(new URL(url));
}

export interface VerifiedUser {
  uid: string;
  email: string | null;
  name: string | null;
}

/**
 * Verify a bearer token from an Authorization header.
 *
 * Returns null for every failure — malformed, expired, wrong project, missing.
 * Callers must treat null as unauthenticated and must never fall back to a
 * default user id.
 */
export async function verifyIdToken(authorization: string | undefined): Promise<VerifiedUser | null> {
  const environment = getEnvironment();
  const projectId = environment.FIREBASE_PROJECT_ID;

  // Picked up here rather than at module load: the test suite points this at a
  // local key set during setup, before the first request is made.
  useJwksUrl(environment.FIREBASE_JWKS_URL);

  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });

    const uid = typeof payload.sub === "string" ? payload.sub : null;
    if (!uid) return null;

    return {
      uid,
      email: typeof payload["email"] === "string" ? payload["email"] : null,
      name: typeof payload["name"] === "string" ? payload["name"] : null,
    };
  } catch {
    return null;
  }
}
