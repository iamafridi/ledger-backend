export type WarehouseEventType =
  | "GOODS_RECEIVED"
  | "SALE_DISPATCHED"
  | "DRAFT_CREATED"
  | "DOC_VOIDED"
  | "STOCK_TRANSFERRED"
  | "STOCK_ADJUSTED"
  | "STOCKTAKE_COMPLETED"
  | "DEPRECIATION_POSTED"
  | "INTEGRITY_FAILED"
  | "PERIOD_LOCKED";

export interface EventLineItem {
  itemId: string;
  itemName: string;
  qty: number;
  unit: string;
}

export interface DomainWarehouseEvent {
  id: string;
  orgId: string;
  type: WarehouseEventType;
  occurredAt: string;
  refType: "BILL" | "INVOICE" | "TRANSFER" | "ADJUSTMENT" | "STOCKTAKE" | "DEPRECIATION" | "PERIOD";
  refId: string;
  docNo: string;
  partyName: string;
  warehouseId: string;
  warehouseName?: string;
  lines: EventLineItem[];
  valuePaisa: number;
  status: "POSTED" | "DRAFT" | "VOIDED";
}

export interface StockPositionSummary {
  id: string;
  code: string;
  name: string;
  category: string;
  unit: string;
  qtyOnHand: number;
  reorderLevel: number;
  avgCostPaisa: number;
  warehouseId: string;
  rackId: string;
  shelfLevel: number;
  maxCapacity: number;
}

export interface WarehouseLocationSummary {
  id: string;
  code: string;
  name: string;
  address: string;
  totalCapacityUnits: number;
  usedCapacityUnits: number;
  totalValuePaisa: number;
  activeDocks: number;
}

export interface WarehouseSnapshotResponse {
  warehouses: WarehouseLocationSummary[];
  items: StockPositionSummary[];
  openDraftsCount: number;
  totalValuationPaisa: number;
  recentEvents: DomainWarehouseEvent[];
  fiscalPeriod: {
    name: string;
    isLocked: boolean;
  };
}
