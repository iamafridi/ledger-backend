/**
 * Run every integrity check and report the result.
 *
 *   npx tsx scripts/integrity-check.ts          human-readable summary
 *   npx tsx scripts/integrity-check.ts --json   machine-readable report only
 *
 * Exit code 0 when nothing failed, 1 when a check failed. `skipped` is not a
 * failure: it means the data the invariant governs has not been built yet, and
 * reporting that honestly is the whole point of a skip rather than a pass.
 *
 * Wired into CI, so a phase that breaks an earlier phase's invariant fails the
 * build instead of reaching review.
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { runIntegrityChecks, type CheckResult } from "../src/core/integrity.js";

// A skipped check means the invariant's data has not been built yet. That is
// expected through Phase 0 and must not read as a failure.
const STATUS_SYMBOL: Record<CheckResult["status"], string> = {
  pass: "PASS",
  fail: "FAIL",
  skipped: "SKIP",
};

const asJson = process.argv.includes("--json");


async function main(): Promise<void> {
  await connectDatabase();
  const report = await runIntegrityChecks();

  if (asJson) {
    // Nothing else may touch stdout: this is the machine-readable channel.
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`\nLedger integrity check — ${report.ran_at} (${report.duration_ms}ms)\n\n`);
    for (const check of report.checks) {
      process.stdout.write(
        `  [${STATUS_SYMBOL[check.status]}] ${check.id.padEnd(24)} ${check.title}` +
          `${check.checked ? `  (${check.checked} checked)` : ""}\n`,
      );
      for (const finding of check.findings) {
        process.stdout.write(`         → ${finding}\n`);
      }
    }
    const failed = report.checks.filter((c) => c.status === "fail").length;
    const skipped = report.checks.filter((c) => c.status === "skipped").length;
    process.stdout.write(
      `\n  ${report.ok ? "OK" : "FAILED"} — ` +
        `${report.checks.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped\n\n`,
    );
  }

  await disconnectDatabase();
  process.exit(report.ok ? 0 : 1);
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
