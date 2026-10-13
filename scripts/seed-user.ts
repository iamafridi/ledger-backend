/**
 * Seed a published case into a user's account from the command line.
 *
 * Takes a Firebase uid directly, so a demo account can be prepared without
 * signing in as that user or holding their password anywhere.
 *
 *   npx tsx scripts/seed-user.ts <firebase-uid> [CASE-ID]
 *   npx tsx scripts/seed-user.ts 4K4HBc... PUB-01
 *
 * Idempotent: running it twice leaves the same ledger rather than a doubled one.
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { listCases, seedCase } from "../src/modules/demo/demo.service.js";
import { OrganizationModel } from "../src/modules/org/org.model.js";

async function main(): Promise<void> {
  const uid = process.argv[2];
  const caseId = process.argv[3] ?? "PUB-01";

  if (!uid) {
    console.error("Usage: npx tsx scripts/seed-user.ts <firebase-uid> [CASE-ID]");
    console.error(`Cases: ${listCases().map((c) => c.case_id).join(", ")}`);
    process.exit(1);
  }

  await connectDatabase();

  // The case is posted into the user's organisation as well as their account
  // (plan §4, D3), so the script resolves that organisation rather than taking
  // an id on the command line that could belong to somebody else.
  const org = await OrganizationModel.findOne({ owner_uid: uid }).lean();
  if (!org) {
    console.error(
      `No organisation exists for uid ${uid}. Sign in once — the organisation, chart of accounts ` +
        `and first fiscal year are created on the first authenticated request.`,
    );
    await disconnectDatabase();
    process.exit(1);
  }

  const result = await seedCase(String(org._id), uid, caseId);

  console.log(`Seeded ${result.case_id} for uid ${uid}`);
  console.log(`  months     ${result.last_month} and ${result.month}`);
  console.log(`  salary     ${result.salary_bdt}`);
  console.log(`  expenses   ${result.expenses}`);
  console.log(`  pockets    ${result.pockets}`);
  console.log(`  ledger     ${result.ledger.posted} posted, ${result.ledger.failed} failed`);
  if (result.ledger.opened_years.length > 0) {
    console.log(`  years      opened ${result.ledger.opened_years.join(", ")} to reach the case dates`);
  }
  for (const failure of result.ledger.failures) {
    console.log(`  failed     ${failure}`);
  }

  await disconnectDatabase();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
