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

## 2026-11-06: Steadyline Care P7 hardening (part 1: auth)

**Changed:** Added an in-memory fixed-window `RateLimiter`: sign-in lockout per phone (5 failures/15 min, cleared by a successful login) and per address, reset-code requests per phone and address, registrations per address; 429 with `Retry-After`. Password reset by OTP (`/api/auth/reset/request` and `/confirm`): hashed single-use code, 15-minute expiry, 5 guesses, identical answer for unknown numbers. Session revocation via a `token_version` column checked on every request (`logout-all`, admin revoke, and every password reset). `TRUST_PROXY=1` so limits see real client addresses behind Render.
**Tests:** 3 limiter unit tests and 13 API tests: lockout, recovery after success, per-address limit, registration limit, reset happy path with old session invalidated, enumeration-safe answers, code never in outbox/DB in clear, guess burn-out, expiry and supersession, disabled accounts, revocation by self and admin.
**Learned:** The notification outbox is readable by ops, so it would have exposed reset codes; messages can now carry a `storedBody` that replaces the text in the outbox. A reset must also bump the token version, otherwise a hijacked session survives the password change.
**Caveat:** Limits are per process (fine for one instance). No UI yet for "forgot password" in the web app, API only.
**Next:** P7 remainder: nightly SQLite backup script and the Postgres option; forgot-password screen in the web app.

## 2026-11-07: Steadyline Care P7 hardening (part 2: backups)

**Changed:** `platform/src/backup.ts`: online SQLite snapshots via the backup API, written to a `.partial` file, checked with `PRAGMA integrity_check`, then renamed; only the newest N (default 14) `care-<UTC stamp>.db` files are kept and other files in the folder are never touched. `npm run backup -- [dir] [keep]` for cron, and `BACKUP_DIR` (plus `BACKUP_KEEP`, `BACKUP_HOUR_UTC`) makes the server snapshot nightly at 21:00 UTC. README has a Backups section with restore steps.
**Tests:** 4 new: snapshot is consistent and excludes later writes, retention and foreign-file safety, bad retention and failed backup leave no partial file, next-run arithmetic.
**Learned:** `db.backup()` is async and safe during writes; verifying before the rename means a bad copy never looks valid.
**Caveat:** The scheduler timer itself is not tested (only its arithmetic), and backups stay on the same disk unless copied off. No encryption of snapshots.
**Next:** P7 remainder: Postgres option and a forgot-password screen; or dashboard Day 3.

## 2026-11-08: Dashboard Day 3 (onboarding and quick-add logging, part 1)

**Changed:** `src/logging/quickadd.ts` parses one line of shorthand (`g 112`, `bp 128/82`, `sym joint pain 3 left knee`, `med metformin missed`, sleep, mood, food, activity, trigger, note) into validated FHIR resources with clear errors for bad input. `src/logging/onboarding.ts` builds the Patient and deduplicated Conditions. `src/ui/log-view.ts` (`#/log`, linked from the unlocked vault) shows onboarding on first run, then a quick-add box (`/` focuses, Enter saves) that writes to the encrypted vault.
**Tests:** 22 new in `src/logging/logging.test.ts`: every entry type validates, exact values, 18 rejected inputs, onboarding happy and error paths.
**Learned:** The builders already covered most entry types, so the real work was unambiguous grammar: symptom names run up to the first number, and the rest is the body location.
**Caveat:** The log screen is typechecked but not run in a browser, and there is no e2e yet, so the "under 5 s by keystroke count" criterion is unmeasured and Day 3 stays unticked.
**Next:** e2e for onboarding + quick-add keystroke count, then Day 4 (templates, BP category and chart).

## 2026-11-09: Dashboard Day 4 (blood pressure metrics and panel)

**Changed:** `src/metrics/bp.ts`: ACC/AHA 2017 classification (normal, elevated, stage 1, stage 2, crisis above 180/120, higher of the two numbers wins), extraction of BP panels from Observations, mean, per-category shares, worst reading, daily means. `bpChart` (solid systolic, dashed diastolic, 130/80 reference lines, category data table) and a Blood pressure section in the demo dashboard.
**Tests:** table-driven threshold tests (15 boundary cases) plus extraction, malformed panels, summary and daily-average tests.
**Learned:** The guideline's crisis cut-off is strictly above 180/120, so 180/120 is still stage 2; pinned by a test.
**Caveat:** The chart is built and typechecked but not browser-tested. Per-condition quick-add templates (the other half of Day 4) are not done, so Day 4 is `[~]`.
**Next:** Condition templates for quick-add, then the e2e for onboarding/logging once Playwright browsers are available.

## 2026-11-09 (second session): Dashboard Day 4 (per-condition quick-add templates)

**Changed:** `src/logging/templates.ts`: suggestions per condition (all 12 supported), deduplicated across conditions, general ones (note, sleep, mood) last; `conditionKeys` maps stored Condition SNOMED codes back to keys. `#/log` shows them as chips that prefill the quick-add box.
**Tests:** 5 new: every template example parses into valid resources, every condition has templates, ordering and dedupe, unknown keys, key round trip.
**Learned:** Templates prefill shorthand rather than adding a second input path, so validation stays in one parser.
**Caveat:** Chips are typechecked, not browser-tested; Day 4 stays `[~]` and Day 3 unticked until the e2e can run.
**Next:** e2e for onboarding, chips and keystroke count when Playwright browsers exist; otherwise Day 5 CSV importers.

## 2026-11-10: Dashboard Day 5 (CGM CSV importers, part 1)

**Changed:** `src/importers/csv.ts`: streaming RFC 4180 tokenizer over sync/async string chunks (quotes, escaped quotes, embedded newlines, CRLF, BOM, chunk-boundary safe). `src/importers/cgm.ts`: Dexcom Clarity and FreeStyle Libre detection (Libre preamble lines skipped), mg/dL or mmol/L, configurable UTC offset and day-first/month-first dates, plausibility window 20-800 mg/dL, a report with per-line errors (capped at 50, rest counted), ignored non-glucose rows, and dedupe within the file and against already-stored timestamps. Added `mmolToMgdl`.
**Tests:** 10 new: tokenizer edge cases at every chunk size, timestamp parsing, both formats, re-import dedupe, unknown file, 100k rows streamed in small chunks.
**Learned:** Exports carry no time zone, so the offset has to be an explicit option rather than a guess; Dexcom writes "Low"/"High" for out-of-range values, which are reported as errors instead of invented numbers.
**Caveat:** Memory is constant for parsing, but a seen-timestamp set and the output samples grow with the data. No import UI and no Google Fit / Health Connect CSV yet, so Day 5 is `[~]`.
**Next:** Google Fit / Health Connect CSV mapping and an import screen with a progress report; Apple Health after that.

## 2026-11-11: Dashboard Day 5 (vitals CSV importer, part 2)

**Changed:** `src/importers/vitals.ts`: streaming importer for Google Fit / Health Connect style wide CSVs. Columns are recognised by header name (heart rate, weight in kg or lb, SpO2, glucose in mg/dL or mmol/L, temperature in C or F, peak flow, systolic/diastolic), unrelated columns (steps, calories) are listed and ignored. Output is FHIR Observations (BP as a panel) that pass `validateResource`; dedupe within the file and against stored `vitalKey`s.
**Tests:** 3 new: mapping and unit conversion, per-line errors (out of range, bad date, half or inverted BP) plus dedupe, unknown file.
**Learned:** BP needs both columns on the same row; reporting a lone systolic is better than guessing.
**Caveat:** Only daily/row-level values; no import UI yet and not tested against real Takeout files (headers are matched by pattern).
**Next:** Import screen with progress report (Day 5 done), then Apple Health streaming XML (Day 6).

## 2026-11-12: Dashboard Day 6 (Apple Health streaming importer)

**Changed:** `src/importers/xml.ts`: a small SAX-style tokenizer over string chunks (skips Apple's inline DTD, comments and CDATA; quote-aware so `>` inside attribute values is safe; entity decoding; `decodeStream` for `file.stream()` bytes). `src/importers/applehealth.ts`: maps HealthKit heart rate, body mass (kg/lb/g), SpO2 (fraction to %), blood glucose (mg/dL, mmol), temperature (C/F), peak flow and paired systolic/diastolic records to LOINC Observations. Reports unmapped types by count, per-record errors, duplicates (same `vitalKey` as the CSV importers, so cross-format re-imports dedupe), truncation, cancellation (AbortSignal) and progress (characters read).
**Tests:** 11 new in `applehealth.test.ts`: identical events at every chunk size, DTD/comment handling, entities, multi-byte split across byte chunks, unit conversion, BP pairing, 6 kinds of bad record, truncation, non-Health file, cancel + progress, 200k records streamed.
**Learned:** Apple stores SpO2 as a fraction with unit "%", and glucose units look like `mmol<180.1559>/L`; both need explicit handling. Blood pressure arrives as two separate records inside a Correlation, so pairing by start time is simpler than tracking the element nesting.
**Caveat:** Not run against a real multi-GB export; the pending-BP map and seen-key set grow with data. No import screen yet (progress bar/cancel button), so Day 6 is `[~]`.
**Next:** A shared import screen (CSV + Apple Health) with progress and cancel, which closes Day 5 and Day 6; then Day 7 AGP chart.

## 2026-11-13: Shared import screen (Day 5/6 UI)

**Changed:** `src/importers/run.ts`: `sniff` classifies a file from its first 64 KB (Apple Health XML, Dexcom/Libre CGM CSV, otherwise vitals CSV; BOM safe), `runImport` runs the right streaming importer and returns one uniform outcome (counts, notes, line-numbered errors, cancelled flag), `storedKeys` turns vault Observations into dedupe keys. `src/ui/import-view.ts` + `#/import` route + link from the vault screen: file picker, UTC offset and date order, progress bar, cancel, report, explicit Save step.
**Tests:** 8 new in `run.test.ts`: sniffing each kind (with BOM, empty, unrelated XML), CGM dedupe against stored keys, vitals ignored columns, Apple Health unmapped types, cancellation, unrecognised files, save-then-reimport dedupes to zero.
**Learned:** The source is a factory (`() => chunks`) so sniffing reads a fresh stream instead of buffering a multi-GB file. With `exactOptionalPropertyTypes` the options need conditional spreads.
**Caveat:** The screen is typechecked and built, not run in a browser. Parsed CGM samples are not saved: the vault holds FHIR resources only and there is no CGM store yet. Stored-key dedupe loads all Observations, which will not scale to very large vaults.
**Next:** A CGM time-series store (needed by Day 7 AGP), then the AGP chart; browser e2e for log/import when Playwright browsers are available.
