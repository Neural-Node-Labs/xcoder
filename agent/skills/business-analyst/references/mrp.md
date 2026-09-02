# MRP (Material Requirements Planning)

## What it is
A production planning method that calculates what materials/components are needed, how many, and when — working backward from a production plan through the Bill of Materials. Often a module inside ERP rather than a standalone system today.

## MRP I vs. MRP II
- **MRP I** — narrowly calculates material needs: what to order/produce and when, based on demand and lead times.
- **MRP II (Manufacturing Resource Planning)** — expands MRP I to include capacity planning, scheduling, and financial integration — essentially a superset covering the full manufacturing resource picture (materials AND capacity AND cost).

## Core concepts
- **BOM (Bill of Materials)** — the recipe: what components/sub-assemblies make up a finished item, and in what quantity. Can be multi-level (a sub-assembly has its own BOM).
- **MPS (Master Production Schedule)** — the plan for what finished goods to build and when; the primary input to MRP.
- **Lead Time** — time between placing an order (purchase or production) and having the material available. MRP nets this against need dates to determine "order by" dates.
- **Lot Sizing** — the rule for how much to order/produce at once (e.g. lot-for-lot, fixed order quantity, economic order quantity/EOQ, period order quantity).
- **Safety Stock** — buffer inventory to absorb demand/supply variability.
- **Net Requirements Calculation** — Gross requirement (from MPS/BOM explosion) minus on-hand inventory minus scheduled receipts = net requirement to plan.
- **Capacity Requirements Planning (CRP)** — checks whether planned production is actually feasible given machine/labor capacity — the "II" in MRP II.

## Common BA tasks
- Documenting BOM accuracy requirements and change-control process (BOM errors cascade into every planning run).
- Defining lot-sizing rules per item class (e.g. high-value items lot-for-lot to minimize excess inventory; low-value items in larger batches).
- Mapping lead time data ownership (who updates it, how often) — stale lead times are a top cause of bad MRP output.
- Specifying exception/alert requirements (e.g. flag when a planned order date is in the past — "past due" exceptions).

## Common pain points driving MRP projects
- Manual, spreadsheet-based planning that can't keep pace with SKU/BOM complexity.
- Chronic stockouts or excess inventory from poor lead-time or lot-sizing data.
- Planners "gut-feel" overriding system recommendations because they don't trust the data (usually a data-quality problem, not a tool problem).
- No visibility into whether a plan is actually achievable given capacity (missing CRP).

## Sample requirements (illustrative)
- *"As a Production Planner, I want the system to explode a multi-level BOM automatically when I plan a finished good, so that component-level requirements are generated without manual calculation."*
- *"As a Purchasing Agent, I want planned purchase orders flagged when they fall within an item's lead time window, so that I know which need to be released urgently."*
- *"As a Plant Manager, I want capacity checks against the MPS before it's finalized, so that we don't commit to a schedule the shop floor can't achieve."*

## Terminology notes
- Don't confuse MRP's "order" (a planned/actual production or purchase order) with a CRM sales order or ERP's customer sales order — related but distinct objects, often linked via the sales order → MPS → MRP chain.
