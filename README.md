# Ledger API (`ledger-backend`)

> **Autonomous Double-Entry Accounting Core & REST API**  
> Built with Node.js 22, Express 5, TypeScript (strict ESM), and MongoDB (Mongoose 8).  
> Designed for exact decimal arithmetic with zero floating-point drift, multi-document ACID transactions, and continuous mathematical invariant validation.

---

## 1. Architectural Philosophy & Non-Negotiables

### 1.1 Money is Never a Floating-Point Number
JavaScript IEEE-754 64-bit binary floating points inherently suffer from binary representation drift (`0.1 + 0.2 === 0.30000000000000004`). In a financial ledger, compound rounding drift is illegal.
- **Storage:** All monetary quantities are stored in MongoDB as exact **integer paisa** (e.g., `৳ 45,000.50` is stored as `4500050`).
- **Computation:** Arithmetic operations run through `decimal.js` with 40-digit precision.
- **Boundaries:** All API request/response payloads format money as canonical strings with exactly 2 decimal places (e.g., `"45000.50"`).

### 1.2 Single Write Path (`postJournal`)
Every business event that impacts the balance sheet—whether it is an issued invoice, supplier payment, depreciation run, inventory adjustment, or staff salary disbursement—writes through one unified gateway:
```typescript
postJournal(session, orgId, entry);
```
- Operates inside an **atomic MongoDB transaction session**.
- Validates the fundamental double-entry invariant: $\sum \text{Debits} = \sum \text{Credits}$ to the exact paisa. If unbalanced, the transaction aborts with an HTTP `422 Unprocessable Entity`.
- Never bypasses account validation or period lock constraints.

### 1.3 Sub-Ledger Control Tie-Outs (`I1`–`I6`)
The engine continuously verifies that summary control accounts on the General Ledger match their underlying sub-ledger details:
- **`I1` (Balanced Entry):** Total debits equal total credits for every posted journal voucher.
- **`I2` (Trial Balance):** Cumulative debits equal cumulative credits across all active accounts.
- **`I3` (Accounting Equation):** $\text{Assets} = \text{Liabilities} + \text{Equity}$.
- **`I4` (Period Lock):** Closed fiscal periods are permanently immutable.
- **`I5-AR`:** General Ledger Account `1100` (AR) strictly matches the sum of unpaid invoice balances.
- **`I5-AP`:** General Ledger Account `2000` (AP) strictly matches the sum of unpaid supplier bills.
- **`I5-Stock`:** General Ledger Account `1200` (Inventory) equals the perpetual valuation of warehouse stock.
- **`I5-VAT`:** Account `2100` Output VAT minus Account `1400` Input Tax ties out to the NBR return.
- **`I5-Advances`:** Per-party advance balances tie out to the Advance Sub-Ledger.
- **`I5-Payroll`:** General Ledger Account `2300` (Payroll Payable) matches unpaid payroll batches.

### 1.4 Monotonic Gapless Numbering
Every legal document (Invoices, Bills, Receipts, Payments, Payslips, Tax Challans) claims a sequential number (`YYYY-NN`) atomically inside database transactions. Gaps are forbidden.

---

## 2. Delivered Domain Modules (Phases P0–P13)

### Core Double-Entry Books
- **Chart of Accounts (`/api/v1/coa`):** Standard 5-class accounting hierarchy (`1000–1999` Assets, `2000–2999` Liabilities, `3000–3999` Equity, `4000–4999` Revenue, `5000–5999` Expenses).
- **Journals (`/api/v1/journals`):** Live multi-line balanced voucher entry, draft vouchers, posted status, and reversal/void vouchers.
- **Fiscal Periods & Close Wizard (`/api/v1/periods`):** Monthly lock dates, fiscal year definitions, and 5-step guided month-end closing checklist.
- **Recurring Entries (`/api/v1/recurring`):** Scheduled templates (monthly, quarterly, annual) with automated next-period auto-reversing accruals (`ACCRUAL_REVERSAL`).
- **Budgets & Variance (`/api/v1/budgets`):** Fiscal period budget matrix with bulk upsert and real-time Budget vs. Actual variance reporting.
- **Segment Accounting (`/api/v1/segments`):** Cost centers, branches, and project tagging on individual journal lines.

### Commercial & Trade
- **Sales & Invoicing (`/api/v1/sales`):** B2B tax invoices, line discounts, statutory VAT calculations, partial payment receipts, customer advance clearing, and AR aging analysis.
- **Purchases & AP (`/api/v1/purchases`):** Procurement bills, 3-way line matching, withholding tax challans, debit notes, and AP aging schedules.
- **Inventory & Costing (`/api/v1/inventory`):** Multi-warehouse perpetual stock tracking, moving-average cost recalculation on procurement, and stocktake reconciliation.
- **Party Advances (`/api/v1/advances`):** Customer deposits and supplier prepayments with FIFO auto-adjustment against invoices and bills.

### Treasury, Tax & Compliance
- **Banking & Cash (`/api/v1/banking`):** Bank and cash control accounts mapped 1:1 onto chart asset accounts, wire transfers, statement CSV fingerprinting, and walk-to-zero bank reconciliation.
- **Statutory Tax & VAT (`/api/v1/tax`):** Bangladesh NBR Form 9.1 VAT return generator, output tax vs. input rebate calculation with whole-taka truncation rules, and withholding tax certificates.
- **Fixed Assets (`/api/v1/assets`):** Asset register, straight-line depreciation engine with salvage floor and partial-month proration, monthly depreciation batches, and disposal entries.
- **Staff Payroll & Loans (`/api/v1/staff`):** Employee master records, 2-step salary posting (accrual & disbursement), 12/24-month loan amortization schedules with automated payroll recovery, and numbered payslips.

### Personal Cashflow & Intake
- **Receipt OCR (`/api/v1/receipts`):** Multi-provider AI vision scanning (Claude Vision / OpenAI) for automatic category, vendor, and amount extraction.
- **Savings Pockets (`/api/v1/savings-pockets`):** Personal savings pockets and Deposit Pension Scheme (DPS) compounding projections.
- **Deterministic Insights (`/api/v1/dashboard/insights`):** Days Sales Outstanding (DSO), cash runway forecast, and receivables aging heatmap.

---

## 3. Technology Stack

- **Runtime:** Node.js $\ge 22.0.0$ (ESM native)
- **Framework:** Express 5
- **Language:** TypeScript 5.9 (Strict mode)
- **Database:** MongoDB 7.0+ via Mongoose 8
- **Authentication:** Firebase Admin SDK (verified JWT bearer tokens)
- **Mathematical Engine:** `decimal.js` (40 significant digits)
- **Validation:** Zod schemas on all request parameters and bodies
- **Security:** Helmet, CORS with origin whitelist, Express Rate Limit
- **Testing:** Vitest 3

---

## 4. Repository Structure

```
ledger-backend/
├── src/
│   ├── config/              # Environment parsing and Firebase initialization
│   ├── core/                # Pure mathematical and financial engines
│   │   ├── audit.ts         # Append-only audit logger
│   │   ├── calendar.ts      # Zero-timezone fiscal calendar arithmetic
│   │   ├── depreciation.ts  # Straight-line asset depreciation engine
│   │   ├── dps.ts           # Deposit pension compounding calculator
│   │   ├── integrity.ts     # Invariant check suite (I1 through I6)
│   │   ├── money.ts         # Integer paisa decimal arithmetic
│   │   ├── posting.ts       # Atomic journal posting gateway
│   │   ├── sequence.ts      # Monotonic sequence claim engine
│   │   └── tax.ts           # Inclusive/exclusive tax and rebate calculator
│   ├── modules/             # Domain modules (routes, controllers, models, services)
│   │   ├── advances/        # Customer & supplier advance adjustment
│   │   ├── auth/            # User onboarding and token verification
│   │   ├── banking/         # Bank control accounts and reconciliation
│   │   ├── budgets/         # Budget matrix and variance analysis
│   │   ├── coa/             # Chart of accounts management
│   │   ├── dashboard/       # Financial metrics and telemetry
│   │   ├── demo/            # 1-click enterprise and sample case seeders
│   │   ├── fixed-assets/    # Asset register and batch depreciation
│   │   ├── inventory/       # Stock tracking and moving-average costing
│   │   ├── journals/        # Double-entry voucher composer and GL
│   │   ├── masterdata/      # Parties, items, and price catalogs
│   │   ├── org/             # Multi-tenant organization and RBAC
│   │   ├── payroll/         # Staff records, loans, and payslip runs
│   │   ├── periods/         # Fiscal years and month-end closing wizard
│   │   ├── pockets/         # Savings pockets and DPS schedules
│   │   ├── purchases/       # Procurement bills and supplier payments
│   │   ├── receipts/        # AI OCR vision intake engine
│   │   ├── recurring/       # Recurring journals and auto-reversing accruals
│   │   ├── reports/         # 20-report catalog with CSV streaming
│   │   ├── sales/           # Invoicing and customer receipts
│   │   ├── segments/        # Branches and cost-center dimensions
│   │   ├── tax/             # Statutory NBR Form 9.1 VAT engine
│   │   └── warehouse/       # Multi-facility stock management
│   ├── shared/              # Shared middleware, error envelopes, and utilities
│   ├── app.ts               # Express application composition
│   └── server.ts            # HTTP server bootstrap and graceful shutdown
└── tests/                   # Automated Vitest calculation & domain suites
    ├── depreciation.test.ts # Asset schedule verification
    ├── dps.test.ts          # Compounding calculation assertions
    ├── money.test.ts        # Decimal paisa arithmetic assertions
    ├── recurring.test.ts    # Accrual reversal verification
    ├── tax.test.ts          # NBR VAT whole-taka rules
    └── warehouse.test.ts    # Stock valuation assertions
```

---

## 5. Environment Configuration

Create a `.env` file in `ledger-backend/` based on the following specifications:

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `PORT` | Local HTTP listener port | `4000` |
| `NODE_ENV` | Runtime environment (`development` / `production`) | `development` |
| `MONGODB_URI` | MongoDB connection string (supports Atlas / Replica Set) | `mongodb+srv://...` |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed CORS client origins | `http://localhost:3000` |
| `FIREBASE_PROJECT_ID` | Firebase project identifier for token verification | `ledger-accounting` |
| `FIREBASE_CLIENT_EMAIL`| Service account email (optional for local emulator) | `firebase-adminsdk@...` |
| `FIREBASE_PRIVATE_KEY` | Service account private key (PEM formatted) | `"-----BEGIN PRIVATE KEY...-----"` |
| `ANTHROPIC_API_KEY` | Optional Anthropic key for receipt vision OCR | `sk-ant-...` |
| `OPENAI_API_KEY` | Optional OpenAI key for receipt vision OCR | `sk-...` |

---

## 6. Installation & Local Development

### 6.1 Install Dependencies
```bash
cd ledger-backend
npm install
```

### 6.2 Start the API Server
```bash
# Starts development server with live TypeScript reload (tsx watch)
npm run dev
```
The server will bind to `http://localhost:4000`. Verify system health:
```bash
curl http://localhost:4000/api/v1/health
```
Expected output:
```json
{
  "success": true,
  "data": {
    "service": "ledger-api",
    "status": "ok",
    "database": "connected"
  }
}
```

### 6.3 Run Test Suite
```bash
# Runs Vitest unit and calculation tests
npm test
```

### 6.4 Typecheck
```bash
# Enforces zero TypeScript compiler errors
npm run typecheck
```

---

## 7. Key REST API Endpoints

All authenticated requests require the header:  
`Authorization: Bearer <Firebase_ID_Token>`

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/v1/health` | Service and database connectivity health check |
| `POST`| `/api/v1/demo/enterprise` | Seeds complete realistic company with customers, invoices, bills, assets, and payroll |
| `GET` | `/api/v1/coa` | Hierarchical Chart of Accounts tree |
| `POST`| `/api/v1/coa` | Register new general ledger account |
| `GET` | `/api/v1/journals` | Paginated list of double-entry vouchers |
| `POST`| `/api/v1/journals` | Post balanced multi-line journal voucher |
| `GET` | `/api/v1/sales/invoices` | List sales invoices with payment & advance status |
| `POST`| `/api/v1/sales/invoices` | Draft / issue invoice with automated 15% VAT |
| `POST`| `/api/v1/sales/receipts` | Allocate customer payment against outstanding invoices |
| `GET` | `/api/v1/purchases/bills` | List procurement bills and payables |
| `POST`| `/api/v1/purchases/bills` | Register vendor bill with perpetual inventory debit |
| `GET` | `/api/v1/banking/accounts` | Cash and bank accounts mapped to GL assets |
| `POST`| `/api/v1/banking/transfers` | Record balanced internal fund transfer |
| `POST`| `/api/v1/banking/reconcile` | Finalize statement walk-to-zero bank reconciliation |
| `GET` | `/api/v1/tax/returns/nbr-9-1` | Generate official Bangladesh NBR Form 9.1 VAT return |
| `GET` | `/api/v1/assets` | Fixed asset register with accumulated depreciation |
| `POST`| `/api/v1/assets/depreciation-runs` | Execute batch straight-line depreciation run |
| `GET` | `/api/v1/staff` | Employee list with active loans and salary history |
| `POST`| `/api/v1/staff/payroll-runs` | Execute monthly salary accrual and loan recovery run |
| `GET` | `/api/v1/reports/:code` | Compile financial report (Trial Balance, P&L, Balance Sheet, Aging) |
| `GET` | `/api/v1/reports/:code/csv` | Stream RFC-4180 formatted CSV export of financial report |
