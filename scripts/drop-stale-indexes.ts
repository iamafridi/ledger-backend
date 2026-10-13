/**
 * Drops indexes left behind by the superseded schema.
 *
 * The earlier build keyed documents on `firebaseUid`; this one keys them on
 * `uid`. The old unique index on (firebaseUid, month) survived the migration,
 * and because no document written by the current code sets `firebaseUid`, every
 * row now carries `firebaseUid: null` — so that index treats two different users
 * saving a salary for the same month as a duplicate and rejects the second.
 *
 * It is not a hypothetical: it surfaced as a 500 on the first seed.
 *
 *   npx tsx scripts/drop-stale-indexes.ts
 *
 * Safe to run repeatedly; an index that is already gone is skipped.
 */
import mongoose from "mongoose";

import { connectDatabase, disconnectDatabase } from "../src/config/database.js";

/** Every index the current schemas legitimately declare, plus Mongo's own. */
const KEEP = new Set([
  "_id_",
  "uid_1",
  "uid_1_month_1",
  "uid_1_month_1_date_-1",
  "uid_1_month_1_category_1",
  "uid_1_createdAt_1",
]);

const COLLECTIONS = ["salaries", "expenses", "pockets", "settings", "savingspockets"];

async function main(): Promise<void> {
  await connectDatabase();
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle after connect.");

  const present = new Set((await db.listCollections().toArray()).map((c) => c.name));

  for (const name of COLLECTIONS) {
    if (!present.has(name)) {
      console.log(`- ${name}: not present, skipping`);
      continue;
    }

    const collection = db.collection(name);
    const indexes = await collection.indexes();

    for (const index of indexes) {
      const indexName = index.name;
      if (!indexName || KEEP.has(indexName)) continue;

      // Anything keyed on the retired field is stale by definition.
      const keys = Object.keys(index.key ?? {});
      const stale = keys.some((key) => key === "firebaseUid");
      if (!stale) {
        console.log(`  ${name}.${indexName}: unrecognised but not on firebaseUid — left alone`);
        continue;
      }

      await collection.dropIndex(indexName);
      console.log(`  ${name}.${indexName}: DROPPED (keyed on the retired firebaseUid)`);
    }
  }

  // Rebuild what the current schemas declare, so the correct unique constraint
  // on (uid, month) is definitely in place.
  const { SalaryModel } = await import("../src/modules/salary/salary.model.js");
  const { ExpenseModel } = await import("../src/modules/expenses/expense.model.js");
  const { PocketModel } = await import("../src/modules/pockets/pocket.model.js");
  await Promise.all([
    SalaryModel.syncIndexes(),
    ExpenseModel.syncIndexes(),
    PocketModel.syncIndexes(),
  ]);
  console.log("\nIndexes synced to the current schemas.");

  await disconnectDatabase();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
