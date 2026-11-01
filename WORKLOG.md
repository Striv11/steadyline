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
