import { Router, type Request, type Response } from "express";
import { getWarehouseSnapshot } from "./warehouse.service.js";
import { warehouseEventsEmitter } from "./warehouse.outbox.js";
import type { DomainWarehouseEvent } from "./warehouse.types.js";

export const warehouseRouter = Router();

// GET /api/v1/warehouse/snapshot
warehouseRouter.get("/snapshot", async (req: Request, res: Response) => {
  try {
    const orgId = (req.query.orgId as string) || (req as any).auth?.orgId || "demo_org";
    const snapshot = await getWarehouseSnapshot(orgId);
    res.json(snapshot);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to fetch warehouse snapshot" });
  }
});

// GET /api/v1/warehouse/events/stream (SSE Stream)
warehouseRouter.get("/events/stream", (req: Request, res: Response) => {
  const orgId = (req.query.orgId as string) || (req as any).auth?.orgId || "demo_org";

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable proxy buffering for nginx/render

  // Send initial connection confirmation
  res.write(`event: connected\ndata: ${JSON.stringify({ status: "connected", orgId, timestamp: new Date().toISOString() })}\n\n`);

  const eventListener = (event: DomainWarehouseEvent) => {
    res.write(`event: warehouse_event\ndata: ${JSON.stringify(event)}\n\n`);
  };

  warehouseEventsEmitter.on(`event:${orgId}`, eventListener);
  warehouseEventsEmitter.on("event:all", eventListener);

  // Keep-alive heartbeat every 20 seconds
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    warehouseEventsEmitter.off(`event:${orgId}`, eventListener);
    warehouseEventsEmitter.off("event:all", eventListener);
  });
});
