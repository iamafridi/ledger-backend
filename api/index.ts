import type { Request, Response } from "express";
import { createApp } from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";

const app = createApp();

export default async function handler(req: Request, res: Response) {
  // Ensure cached MongoDB connection is active
  await connectDatabase();
  return app(req, res);
}
