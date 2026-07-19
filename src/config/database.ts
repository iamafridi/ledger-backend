/**
 * MongoDB connection.
 *
 * Cached on globalThis so a dev-server hot reload reuses one pool instead of
 * opening a new one per reload until Atlas refuses connections.
 */
import mongoose from "mongoose";

import { getEnvironment } from "./env.js";

declare global {
  var __ledgerMongoose: Promise<typeof mongoose> | undefined;
}

export async function connectDatabase(): Promise<void> {
  const { MONGODB_URI, MONGODB_DB } = getEnvironment();

  if (!globalThis.__ledgerMongoose) {
    globalThis.__ledgerMongoose = mongoose.connect(MONGODB_URI, {
      dbName: MONGODB_DB,
      // Fail fast. A hung cluster must not hold a request open for the driver's
      // 30-second default while a user stares at a spinner.
      serverSelectionTimeoutMS: 10_000,
    });
  }

  await globalThis.__ledgerMongoose;
}

export async function disconnectDatabase(): Promise<void> {
  globalThis.__ledgerMongoose = undefined;
  await mongoose.disconnect();
}

export function databaseReady(): boolean {
  return mongoose.connection.readyState === 1;
}
