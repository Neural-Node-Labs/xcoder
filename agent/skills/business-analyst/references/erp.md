# ERP (Enterprise Resource Planning)

## What it is
A single integrated system that manages core business processes — finance, procurement, inventory, manufacturing, sales, HR — on one shared database, so departments stop working off disconnected spreadsheets and siloed tools.

## Core modules
- **Financials / GL** — general ledger, accounts payable/receivable, fixed assets, financial close.
- **Procurement** — purchase requisitions, purchase orders, vendor management, three-way match (PO/receipt/invoice).
- **Inventory Management** — stock levels, warehouse locations, stock transfers, cycle counting.
- **Manufacturing/Production** — work orders, BOM, shop floor control (often integrates with or includes MRP — see `mrp.md`).
- **Sales & Order Management** — quote-to-order, order fulfillment, invoicing.
- **HR/Payroll** — often a lighter module vs. dedicated HCM systems (see `hcm.md`).
- **Reporting/BI** — cross-module dashboards and analytics.

## Major vendors (landscape, not endorsements)
- **Enterprise/large:** SAP S/4HANA, Oracle Fusion Cloud ERP
- **Mid-market:** Microsoft Dynamics 365, NetSuite, Infor, Epicor
- **Manufacturing-focused:** SAP Business One, Sage X3

## Common BA tasks on ERP projects
- **Fit-gap analysis** — compare out-of-box ERP functionality against documented business requirements; classify gaps as configuration, customization, or process-change-instead.
- **Business process reengineering** — ERP implementations often force process standardization; BA reconciles "how we do it today" against the system's native workflow.
- **Data migration requirements** — define what master data (customers, vendors, items, chart of accounts) must migrate, cleansing rules, and mapping from legacy systems.
- **Integration mapping** — document what other systems (CRM, e-commerce, banking, EDI) must connect to the ERP, and via what method (API, middleware, flat file).
- **Role/security matrix** — define who can see/do what (segregation of duties matters a lot here for financial controls).

## Common pain points driving ERP projects
- Disconnected systems causing duplicate data entry and reconciliation effort.
- No real-time visibility into inventory, cash position, or order status.
- Manual, error-prone month-end close.
- Inability to scale reporting/compliance as the company grows (e.g. multi-entity, multi-currency).

## Sample requirements (illustrative)
- *"As a Controller, I want the system to auto-post inventory transactions to the GL in real time, so that financial reports reflect current inventory value without manual journal entries."*
- *"As a Purchasing Manager, I want a three-way match between PO, receipt, and invoice before an invoice can be paid, so that we prevent duplicate or fraudulent payments."*
- *"As an Operations Director, I want role-based dashboards showing open orders by warehouse, so that fulfillment bottlenecks are visible without pulling manual reports."*

## Terminology notes
- "Order" in ERP usually means a **sales order** or **purchase order** — distinct from a CRM "opportunity" or MRP "work order."
- "Chart of Accounts" (COA) is the backbone of financial reporting — changes to it late in a project are costly.
