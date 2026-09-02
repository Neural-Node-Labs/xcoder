# CRM (Customer Relationship Management)

## What it is
A system for managing all interactions with prospects and customers across marketing, sales, and service — the goal is a single view of the customer relationship instead of contact info scattered across inboxes and spreadsheets.

## Core functional areas
- **Lead/Contact Management** — capturing and qualifying prospects, deduplication, contact/account hierarchy.
- **Sales Pipeline Management** — opportunity stages, forecasting, quote generation, deal tracking.
- **Marketing Automation** — email campaigns, lead scoring, nurture sequences, campaign ROI tracking.
- **Customer Service/Support** — case/ticket management, SLAs, knowledge base, omnichannel support (chat, email, phone).
- **Reporting/Analytics** — pipeline health, conversion rates, customer lifetime value (CLV), churn.

## The lead-to-cash flow (typical)
Lead → Marketing Qualified Lead (MQL) → Sales Qualified Lead (SQL) → Opportunity → Quote → Closed-Won/Lost → (handoff to ERP for order fulfillment/invoicing, if separate systems).

## Major vendors (landscape, not endorsements)
- **Enterprise:** Salesforce, Microsoft Dynamics 365 Sales, Oracle CX
- **Mid-market/SMB:** HubSpot, Zoho CRM, Pipedrive
- **Industry-specific:** Veeva (life sciences), ServiceTitan (field service)

## Common BA tasks
- Defining lead scoring/qualification criteria (what makes a lead "sales-ready").
- Mapping the sales stage definitions and required exit criteria per stage (prevents deals "stuck" in a stage indefinitely).
- Specifying CRM-to-ERP integration points (e.g. Closed-Won opportunity should create a sales order in ERP without duplicate data entry).
- Data quality/dedup rules — CRM data rots fast without governance (duplicate accounts, stale contacts).
- Defining SLA rules for support cases (response time by priority/tier).

## Common pain points driving CRM projects
- Sales reps tracking deals in personal spreadsheets — no pipeline visibility for leadership.
- Marketing and sales disagreeing on what counts as a qualified lead (misalignment kills conversion).
- No single customer view — support doesn't know what sales promised, sales doesn't know open support issues.
- Manual, error-prone handoff from "deal closed" to actual order fulfillment.

## Sample requirements (illustrative)
- *"As a Sales Manager, I want automated stage-to-stage validation (e.g. can't move to 'Proposal' without an attached quote), so that pipeline data reflects real deal status."*
- *"As a Marketing Manager, I want leads auto-routed to the right sales rep based on territory and lead score, so that hot leads aren't sitting unassigned."*
- *"As a Support Agent, I want to see a customer's full purchase history and open opportunities on the case screen, so that I can respond with full context."*

## Terminology notes
- "Opportunity" (CRM) ≠ "Order" (ERP) — an opportunity becomes an order only after it's won; conflating them in requirements causes integration design errors.
- "Account" in CRM usually means a company/organization, not a financial ledger account (as in ERP) — always clarify in cross-domain requirements docs.
