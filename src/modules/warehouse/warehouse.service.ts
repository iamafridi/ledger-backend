import type { WarehouseSnapshotResponse } from "./warehouse.types.js";
import { getRecentEvents } from "./warehouse.outbox.js";

export async function getWarehouseSnapshot(orgId: string): Promise<WarehouseSnapshotResponse> {
  // Built-in warehouse definitions for SME operations
  const warehouses = [
    {
      id: "wh_dhk_01",
      code: "WH-DHK-MAIN",
      name: "Tejgaon Central Fulfillment Hub",
      address: "Plot 14, Tejgaon I/A, Dhaka-1208",
      totalCapacityUnits: 12000,
      usedCapacityUnits: 8450,
      totalValuePaisa: 1245000000, // ৳ 12,450,000.00
      activeDocks: 2,
    },
    {
      id: "wh_ctg_02",
      code: "WH-CTG-PORT",
      name: "Chittagong Port Transit Yard",
      address: "North Patenga, Chittagong",
      totalCapacityUnits: 25000,
      usedCapacityUnits: 16800,
      totalValuePaisa: 2890000000, // ৳ 28,900,000.00
      activeDocks: 4,
    },
  ];

  const items = [
    {
      id: "item_bat_01",
      code: "SKU-BAT-12V",
      name: "RahimAfrooz 12V 200Ah Deep Cycle Battery",
      category: "Energy Storage",
      unit: "PCS",
      qtyOnHand: 240,
      reorderLevel: 100,
      avgCostPaisa: 2450000, // ৳ 24,500.00
      warehouseId: "wh_dhk_01",
      rackId: "rack_a1",
      shelfLevel: 1,
      maxCapacity: 400,
    },
    {
      id: "item_box_02",
      code: "SKU-BOX-5PLY",
      name: "Akij 5-Ply Heavy Export Carton",
      category: "Packaging",
      unit: "BNDL",
      qtyOnHand: 1850,
      reorderLevel: 500,
      avgCostPaisa: 12500, // ৳ 125.00
      warehouseId: "wh_dhk_01",
      rackId: "rack_a2",
      shelfLevel: 2,
      maxCapacity: 3000,
    },
    {
      id: "item_yarn_03",
      code: "SKU-YARN-40S",
      name: "Combed Ring Spun Yarn 40/1",
      category: "Raw Material",
      unit: "KG",
      qtyOnHand: 4200,
      reorderLevel: 2000,
      avgCostPaisa: 42000, // ৳ 420.00
      warehouseId: "wh_dhk_01",
      rackId: "rack_b1",
      shelfLevel: 1,
      maxCapacity: 6000,
    },
    {
      id: "item_oil_04",
      code: "SKU-LUB-200L",
      name: "Industrial Synthetic Gear Oil ISO 320",
      category: "Maintenance",
      unit: "DRUM",
      qtyOnHand: 48,
      reorderLevel: 60,
      avgCostPaisa: 8500000, // ৳ 85,000.00
      warehouseId: "wh_dhk_01",
      rackId: "rack_b2",
      shelfLevel: 1,
      maxCapacity: 120,
    },
  ];

  const recent = getRecentEvents(orgId, 15);

  return {
    warehouses,
    items,
    openDraftsCount: 2,
    totalValuationPaisa: warehouses.reduce((sum, w) => sum + w.totalValuePaisa, 0),
    recentEvents: recent.length > 0 ? recent : [
      {
        id: "evt_init_01",
        orgId,
        type: "GOODS_RECEIVED",
        refType: "BILL",
        refId: "bill_001",
        docNo: "BILL-2026-0881",
        partyName: "RahimAfrooz Energy Ltd.",
        warehouseId: "wh_dhk_01",
        warehouseName: "Tejgaon Central Hub",
        lines: [{ itemId: "item_bat_01", itemName: "12V 200Ah Battery", qty: 40, unit: "PCS" }],
        valuePaisa: 98000000,
        status: "POSTED",
        occurredAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
      },
    ],
    fiscalPeriod: {
      name: "FY2025-26 Q3",
      isLocked: false,
    },
  };
}
