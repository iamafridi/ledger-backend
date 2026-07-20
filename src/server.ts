import { createServer } from "node:http";

import { createApp } from "./app.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { getEnvironment } from "./config/env.js";

async function startServer(): Promise<void> {
  const environment = getEnvironment();

  // Connect before listening. An instance that accepts traffic before its
  // database is up answers the first requests with 500s, and on Render that is
  // exactly the window a health check reads.
  await connectDatabase();

  const server = createServer(createApp());
  server.listen(environment.PORT, () => {
    console.log(`Ledger API listening on port ${environment.PORT} [${environment.NODE_ENV}]`);
  });

  const shutdown = (signal: string): void => {
    console.log(`${signal} received, shutting down.`);
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

startServer().catch((error: unknown) => {
  console.error("Unable to start the API.", error);
  process.exit(1);
});
