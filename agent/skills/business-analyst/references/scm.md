# SCM (Supply Chain Management)

## What it is
Manages the end-to-end flow of goods, information, and money from raw material sourcing through production to final delivery to the customer — broader than MRP (which is production-planning-focused) or pure procurement.

## Core functional areas
- **Procurement/Sourcing** — supplier selection, contracts, purchase order lifecycle.
- **Demand Planning/Forecasting** — predicting future demand to drive inventory and production decisions.
- **Sales & Operations Planning (S&OP)** — cross-functional process balancing demand, supply, and financial plans, typically monthly.
- **Warehouse Management (WMS)** — receiving, put-away, picking, packing, shipping, cycle counting.
- **Transportation/Logistics Management (TMS)** — carrier selection, routing, freight optimization, shipment tracking.
- **Supplier Relationship Management (SRM)** — supplier performance scorecards, risk monitoring.

## Common BA tasks
- Mapping the physical and information flow end-to-end (as-is) before proposing changes — SCM problems often span multiple systems and departments.
- Defining demand forecasting inputs/method (statistical forecast vs. sales input vs. hybrid) and accuracy KPIs (e.g. MAPE — mean absolute percentage error).
- Documenting warehouse process flows (receiving to putaway to pick/pack/ship) to identify bottlenecks before selecting/configuring a WMS.
- Specifying supplier onboarding and performance evaluation criteria (on-time delivery %, quality reject rate).

## Common pain points driving SCM projects
- Poor demand forecast accuracy leading to stockouts or excess inventory.
- No end-to-end shipment visibility — customers/CS can't answer "where's my order."
- Siloed planning — sales, ops, and finance working off different numbers (no S&OP process).
- Manual warehouse processes causing pick errors and slow fulfillment.

## Sample requirements (illustrative)
- *"As a Demand Planner, I want statistical forecasts blended with sales team overrides, so that forecasts reflect both historical patterns and known upcoming deals."*
- *"As a Warehouse Supervisor, I want directed putaway based on item velocity, so that fast-moving items are stored for quick pick access."*
- *"As a Customer Service Rep, I want real-time shipment tracking status visible from the order record, so that I can answer delivery questions without contacting logistics."*

## Terminology notes
- SCM is the umbrella; MRP (production planning) and elements of ERP procurement/inventory sit inside or feed into it. Don't treat SCM and MRP as interchangeable in requirements docs — SCM is broader (includes logistics, supplier management, demand planning) while MRP is specifically the materials-planning calculation.
