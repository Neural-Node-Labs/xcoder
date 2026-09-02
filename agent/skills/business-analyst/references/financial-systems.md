# Financial Systems

## What it is
Covers the systems and processes for recording, controlling, and reporting a company's financial position — usually the financial core of an ERP, but sometimes a standalone/best-of-breed system.

## Core functional areas
- **General Ledger (GL)** — the system of record for all financial transactions, organized by Chart of Accounts.
- **Accounts Payable (AP)** — vendor invoices, payment processing, three-way match (PO/receipt/invoice).
- **Accounts Receivable (AR)** — customer invoicing, cash application, collections, aging.
- **Fixed Assets** — asset tracking, depreciation schedules, disposal.
- **Budgeting/Planning (FP&A)** — budget creation, forecasting, variance analysis.
- **Financial Close/Consolidation** — month/quarter/year-end close process, multi-entity consolidation, intercompany eliminations.
- **Financial Reporting/Compliance** — statutory reporting, audit trail, controls (e.g. SOX in the US).

## Common BA tasks
- Documenting the close process calendar and identifying manual/bottleneck steps (a classic driver for financial systems projects).
- Defining approval workflows and segregation-of-duties requirements (who can create a vendor vs. approve a payment — critical for fraud prevention and audit).
- Mapping Chart of Accounts structure and multi-entity/multi-currency requirements.
- Specifying audit trail requirements (who changed what, when — often a hard compliance requirement, not optional).
- Reconciliation requirements between subledgers (AP, AR, Fixed Assets) and the GL.

## Common pain points driving financial systems projects
- Slow, manual month-end close (spreadsheet consolidation across entities).
- Weak controls — same person can create and approve a payment (audit finding waiting to happen).
- No real-time visibility into cash position or budget-vs-actual.
- Difficulty supporting multi-entity/multi-currency/multi-GAAP reporting as the company scales.

## Sample requirements (illustrative)
- *"As a Controller, I want automated intercompany elimination entries during consolidation, so that the close process doesn't rely on manual spreadsheet reconciliation."*
- *"As an AP Clerk, I want the system to block invoice approval when a vendor is flagged as a duplicate or inactive, so that we prevent erroneous payments."*
- *"As a CFO, I want real-time budget-vs-actual dashboards by department, so that spending overruns are visible before period-end instead of after."*

## Terminology notes
- "Close" refers to the period-end financial close process — distinct from "closing" a sales opportunity (CRM) or "closing" a work order (MRP/manufacturing). Always disambiguate in cross-domain documentation.
- SOX (Sarbanes-Oxley) compliance applies to US public companies and drives strict controls/audit-trail requirements — flag as a hard constraint, not a nice-to-have, when applicable.
