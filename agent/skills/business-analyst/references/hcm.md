# HCM (Human Capital Management)

## What it is
Manages the employee lifecycle from recruiting through offboarding — broader than "payroll software," covering talent acquisition, core HR records, performance, and workforce planning.

## Core functional areas
- **Core HR/HRIS** — employee records, org charts, position management, compliance documentation.
- **Recruiting (ATS – Applicant Tracking System)** — job requisitions, candidate pipeline, interview scheduling, offer management.
- **Payroll** — pay calculation, tax withholding/filing, direct deposit, payslips; often region-specific due to tax/labor law.
- **Benefits Administration** — enrollment, eligibility rules, carrier integration (health, retirement, etc.).
- **Performance Management** — goal setting, reviews, 360 feedback, calibration.
- **Learning Management (LMS)** — training assignment and completion tracking, often compliance-driven.
- **Workforce Planning/Analytics** — headcount planning, turnover analysis, DEI reporting.

## Major vendors (landscape, not endorsements)
- **Enterprise:** Workday, SAP SuccessFactors, Oracle HCM Cloud
- **Mid-market/SMB:** BambooHR, Rippling, Gusto, ADP Workforce Now

## Common BA tasks
- Documenting the hire-to-retire process end-to-end, noting where handoffs between recruiting → onboarding → payroll → benefits currently break down.
- Defining approval workflows for org changes (promotions, transfers, terminations) and who is authorized at each step.
- Specifying compliance requirements (varies heavily by jurisdiction — e.g. FLSA classification in the US, working time directives in the EU) — always confirm with legal/compliance, don't assume.
- Mapping payroll integration requirements (time & attendance system → payroll, benefits carrier files).

## Common pain points driving HCM projects
- Employee data duplicated/inconsistent across recruiting, HRIS, and payroll systems.
- Manual, error-prone benefits enrollment and payroll processing.
- No self-service — HR fielding routine requests (address changes, pay stub requests) manually.
- Poor visibility into headcount/turnover for workforce planning.

## Sample requirements (illustrative)
- *"As an HR Coordinator, I want new hire data entered once in the ATS to auto-populate the HRIS record, so that we eliminate duplicate data entry and transcription errors."*
- *"As a Payroll Manager, I want approved time-and-attendance data to feed payroll automatically, so that manual entry errors don't cause pay discrepancies."*
- *"As an Employee, I want self-service access to update my address and view pay stubs, so that I don't need to submit a request to HR for routine changes."*

## Terminology notes
- "Position" vs. "Employee" — a position can exist (and be budgeted) even when vacant; conflating the two in requirements causes headcount reporting errors.
- Compliance/legal requirements in HCM are jurisdiction-specific — always flag this as a "confirm with legal" item rather than assuming a rule from one country/state applies elsewhere.
