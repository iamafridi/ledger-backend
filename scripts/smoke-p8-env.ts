/**
 * Pre-import hook for the Phase 8 smoke script.
 *
 * The environment is cached the first time `getEnvironment()` runs, and module
 * evaluation order would otherwise decide whether the local JWKS URL or the real
 * one wins. Doing it here — before any `src` import exists in the module graph —
 * makes the order explicit instead of lucky. Port 4574, so a Phase 7 smoke run
 * and a Phase 8 one cannot collide.
 */
process.env["FIREBASE_JWKS_URL"] = "http://127.0.0.1:4574";
