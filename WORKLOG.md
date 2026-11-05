# Work log

Newest entries at the bottom. Each entry records what actually changed, what was learned, and what comes next.

## 2026-11-01 — Day 1

**Done**

- Chose the idea: Steadyline, a local-first chronic-condition dashboard (seeded flagship, 14-day arc).
- Scaffold: Vite, strict TypeScript (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Vitest, ESLint, Prettier, Playwright (desktop + 360 px projects). `check.sh` runs format check, lint, typecheck, tests and build. CI runs `check.sh` plus an e2e job; `pages.yml` deploys `dist` to GitHub Pages.
- FHIR R4 subset (`src/domain`): Patient, Condition (SNOMED), Observation (LOINC, BP panel with components, symptom severity 0-10 with bodySite), MedicationStatement, MedicationAdministration, Bundle; validation at the import boundary with plausible-range checks.
- Seeded synthetic patient (mulberry32): T2D + hypertension + migraine, with planted associations (short sleep raises glucose, BP and migraine risk) for the Day 9 insights tests.
- Glucose metrics: TIR/TAR/TBR (5 bands), GMI, CV, with tests on boundaries and published GMI values; min/max downsampling.
- Landing page and demo dashboard shell with accessible chart (data table), light/dark theme, skip link, disclaimer.
- 21 unit tests and 6 e2e tests pass.

**Learned / caveats**

- CGM is stored as a typed series, not 500k Observation objects. It will be exported to FHIR on demand.
- The LOINC code for peak flow (33452-4) and local codes need review against the current LOINC release; flagged in the README.
- Pages must be enabled in repo settings (source: GitHub Actions) before the live link works.

**Next (Day 2)**: AES-GCM encrypted IndexedDB store with passphrase KDF, lock/unlock UI.

## 2026-11-01: Steadyline Care P1 notifications, P2 live location (interactive session)

**Changed:** Added an outbox-first notifier, so every SMS/WhatsApp is recorded before sending and failures never block requests. A log provider is the default and Twilio SMS/WhatsApp the real one. Message rules for booking, assignment, reassignment, on the way (with ETA and the delivery code), completion, cancellation and no-show, plus pages to every dispatcher and admin on critical readings. Staff phones share location only while en route (throttled to every 30 s). Patients see an ETA. Ops has a Leaflet/OSM live map (lazy-loaded) and a Messages tab.
**Tests:** 33 unit and API tests (message rules, Twilio request format, E.164, recipient lists, ETA shrinking as the nurse approaches, provider failure isolation); 6 browser flows now also check the ETA, location sharing, the map and the outbox.
**Next:** P3 recurring care plans.

## 2026-11-02: Steadyline Care P3 recurring care plans

**Changed:** Added a recurrence engine (`domain/recurrence.ts`), a strict RRULE subset: daily/weekly, INTERVAL, BYDAY, COUNT/UNTIL, Monday-based weeks, local time at a fixed UTC offset (IST by default). Added `care_plans` and `plan_exceptions` tables and `plan_id`/`plan_date` on jobs, with an in-place migration for existing databases. Job creation is now one shared `createJob`, so generated visits get the same validation, auto-dispatch and notifications as bookings. Endpoints: create/list plans, skip/modify/restore one occurrence, end a plan, and an ops "generate now"; the server also tops plans up to 14 days ahead hourly. The patient app has a "Repeating visits" card.
**Tests:** 21 recurrence unit tests (intervals, fortnightly alternation, COUNT vs window, UNTIL, year end, IST day boundary, invalid rules) and 10 API tests (idempotent generation, skip/restore, modify, started visits refused, off-plan dates, end, ownership, ops booking, missing address).
**Learned:** A moved occurrence keeps its original date as the key, so the cancelled original is re-keyed (`date#old`) to let regeneration book the new slot and run dispatch normally. Generation failures (e.g. no address) are audited per date rather than aborting the plan.
**Caveat:** The new patient UI was typechecked but not run in a browser here (Playwright browsers are not installed in this environment), so there is no e2e flow for it yet.
**Next:** P4 payments (Razorpay payment links, webhook signature check, PDF receipts); add an e2e flow for care plans.

## 2026-11-03: Steadyline Care P4 payments

**Changed:** Added `payments.ts`: a payment-provider interface with Razorpay payment links (real) and a fake (tests), HMAC-SHA256 webhook signature verification over the raw body (constant-time compare, refused when no secret is configured), and a dependency-free one-page PDF writer for invoices and receipts. New `payments` table. Endpoints: `POST /api/jobs/:id/payment-link` (owner or ops, reuses an open link, refuses settled/cancelled visits, 501 when unconfigured), `POST /api/webhooks/razorpay` (idempotent, rejects amount/reference mismatches and audits them, marks the job paid in a transaction), `GET /api/jobs/:id/invoice.pdf` (invoice until paid, then receipt). The patient app gets "Pay online" and Invoice/Receipt buttons. Env vars added to README and `render.yaml`.
**Tests:** 16 new: HMAC against the RFC 4231 vector, tampering, event parsing, Razorpay request format and errors, PDF structure (xref offsets verified) and escaping, and API flows for ownership, duplicate webhooks, mismatches and receipts.
**Learned:** Fastify must keep the raw body for signature checks, so a custom JSON parser stores it. The PDF writer only handles Latin-1, so amounts print as "Rs".
**Caveat:** Not run against the live Razorpay API (no credentials); the request and webhook shapes follow their documented payment-link API. UI changes are typechecked but not browser-tested, as before.
**Next:** P5 dashboard link (FHIR Bundle export of visit readings); add e2e flows for care plans and payments.

## 2026-11-03 (second entry): Steadyline Care P5 dashboard link, platform half

**Changed:** `GET /api/me/export.fhir.json[?since=YYYY-MM-DD]` (patients only, audited) returns the patient's visit readings as a FHIR R4 Bundle (Patient plus Observations; LOINC and UCUM; BP as a systolic/diastolic panel). The patient app has a "Download for my dashboard" button under My readings. Docs in `platform/README.md`.
**Tests:** 5 new, including a check that the Bundle passes the dashboard's own `validateBundle`, no other patient's data leaks, `since` filtering and bad input, role and audit checks, and incomplete BP rows being skipped.
**Learned:** Platform ids use underscores, which FHIR ids reject, so they are sanitized. Date of birth lives in `patients`, not `users`.
**Caveat:** P5 is only half done (marked `[~]`). The dashboard has no Bundle import UI (Day 13) or doctor-visit report (Day 12) yet, so "import" and "report includes them" are open. The download button is typechecked, not browser-tested.
**Next:** Dashboard Day 2 (encrypted storage) is the long-standing gap; or P6 ops analytics.

## 2026-11-04: Dashboard Day 2, encrypted local storage

**Changed:** Added `src/storage/`: PBKDF2-SHA256 (600k iterations) yielding 64 bytes split into an AES-256-GCM key and an HMAC key; a `Vault` repository (put/get/delete/query/observations by code and time range) over a small `RawStore` interface, with `MemoryStore` and `IdbStore` implementations. Record keys are HMACs of `type/id`, and each ciphertext is bound to its slot via GCM additional data. A `#/vault` screen creates, unlocks and locks the vault.
**Tests:** 10 unit tests: round trip, wrong passphrase, no plaintext (names, ids, types, codes) in the raw store, bit-flip tamper, record moved between slots, tampered KDF header, queries, overwrite/delete, lock, creation guards.
**Learned:** Hiding types and ids behind an HMAC means queries decrypt every record of the vault; fine at this scale, and an encrypted index is the fix if it ever isn't.
**Caveat:** `IdbStore` and the vault screen were not run in a browser (no Playwright browsers here), so Day 2 is `[~]`. Still open: raw-IndexedDB inspection e2e, typed queries beyond observations.
**Next:** Day 3 onboarding and quick logging on top of the vault, plus an e2e for lock/unlock; or P6 ops analytics.

## 2026-11-05: Steadyline Care P6 ops analytics

**Changed:** `domain/analytics.ts` (pure): staff utilization, revenue per service, cancellation/no-show rates, critical-alert response (nearest-rank median and p90), and a CSV writer that defuses formula injection. `GET /api/ops/analytics` (ops/admin, UTC date window, JSON or per-report CSV, CSV exports audited) and an Analytics tab in the ops app. README updated.
**Tests:** 9 new: percentile, utilization (cancelled excluded, no-shows included, no shifts gives null), waived/unpaid revenue, rate denominators, warnings ignored in alert stats, CSV quoting and formulas, plus API window filtering, CSV, audit, validation and role checks.
**Learned:** Rates use only final-state visits so open bookings don't dilute them. Names come from staff-controlled data, hence the CSV formula guard.
**Caveat:** The Analytics tab is typechecked, not browser-tested (no Playwright browsers here).
**Also:** fixed a flaky vault test (a 2-character needle matched random base64 about 1 run in 20).
**Next:** P7 hardening, or dashboard Day 3 onboarding/logging.
