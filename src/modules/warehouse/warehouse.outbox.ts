import { EventEmitter } from "events";
import type { DomainWarehouseEvent } from "./warehouse.types.js";

class WarehouseOutboxEmitter extends EventEmitter {}

export const warehouseEventsEmitter = new WarehouseOutboxEmitter();

// Ring buffer of recent domain events in memory
const recentEventsBuffer: DomainWarehouseEvent[] = [];
const MAX_BUFFER = 100;

export function publishWarehouseEvent(event: DomainWarehouseEvent): void {
  recentEventsBuffer.unshift(event);
  if (recentEventsBuffer.length > MAX_BUFFER) {
    recentEventsBuffer.pop();
  }
  warehouseEventsEmitter.emit(`event:${event.orgId}`, event);
  warehouseEventsEmitter.emit("event:all", event);
}

export function getRecentEvents(orgId: string, limit = 20): DomainWarehouseEvent[] {
  return recentEventsBuffer
    .filter((e) => e.orgId === orgId || e.orgId === "demo_org" || orgId === "all")
    .slice(0, limit);
}
