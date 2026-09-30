import { describe, expect, it } from "vitest";
import { getWarehouseSnapshot } from "../src/modules/warehouse/warehouse.service.js";
import { publishWarehouseEvent, getRecentEvents } from "../src/modules/warehouse/warehouse.outbox.js";
import type { DomainWarehouseEvent } from "../src/modules/warehouse/warehouse.types.js";

describe("Warehouse Domain & Snapshot Unit Tests", () => {
  it("should generate a valid warehouse snapshot conforming to integer paisa schema", async () => {
    const snapshot = await getWarehouseSnapshot("org_test_01");

    expect(snapshot).toBeDefined();
    expect(snapshot.warehouses.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.items.length).toBeGreaterThanOrEqual(1);

    // Valuations must be positive integer paisa (no floats)
    expect(Number.isInteger(snapshot.totalValuationPaisa)).toBe(true);
    expect(snapshot.totalValuationPaisa).toBeGreaterThan(0);

    for (const wh of snapshot.warehouses) {
      expect(Number.isInteger(wh.totalValuePaisa)).toBe(true);
      expect(wh.totalCapacityUnits).toBeGreaterThan(0);
      expect(wh.usedCapacityUnits).toBeLessThanOrEqual(wh.totalCapacityUnits);
    }

    for (const item of snapshot.items) {
      expect(Number.isInteger(item.avgCostPaisa)).toBe(true);
      expect(item.qtyOnHand).toBeGreaterThanOrEqual(0);
      expect(item.maxCapacity).toBeGreaterThan(0);
    }
  });

  it("should publish and retrieve events in the outbox ring buffer", () => {
    const testEvent: DomainWarehouseEvent = {
      id: `test_evt_${Date.now()}`,
      orgId: "org_outbox_test",
      type: "GOODS_RECEIVED",
      refType: "BILL",
      refId: "bill_test_99",
      docNo: "BILL-TEST-99",
      partyName: "Test Supplier Ltd.",
      warehouseId: "wh_dhk_01",
      lines: [{ itemId: "item_bat_01", itemName: "12V Battery", qty: 10, unit: "PCS" }],
      valuePaisa: 24500000,
      status: "POSTED",
      occurredAt: new Date().toISOString(),
    };

    publishWarehouseEvent(testEvent);

    const recent = getRecentEvents("org_outbox_test", 5);
    expect(recent.length).toBeGreaterThanOrEqual(1);
    expect(recent[0]?.docNo).toBe("BILL-TEST-99");
    expect(recent[0]?.valuePaisa).toBe(24500000);
  });
});
