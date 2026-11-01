# Steadyline Care: the care operations platform

Steadyline Care lets a care business take bookings, send caregivers and couriers to patients' homes, run clinic appointments, and act on dangerous readings. It is one server that serves both the API and the web app. Everyone uses the same web app, and each person sees the screens for their role.

| Role | What they do |
|---|---|
| **Patient** (self sign-up) | Book a home visit, clinic appointment or medicine delivery. See who is coming and when, track status live, get a delivery OTP, see visit notes and readings, rate the visit. |
| **Caregiver** (nurse, physio, attendant, phlebotomist, doctor) | Phone view of their day: directions, a call button, allergies and conditions, notes. Start trip → arrived → begin → record vitals → complete (with notes and payment). |
| **Courier** | Same day view for deliveries; hands over only when the patient's 6-digit OTP matches. |
| **Dispatcher (ops)** | Live board with KPIs, the unstaffed queue (auto-assign, "why nobody?", manual assign), the schedule, the team, alerts, patient records, shifts, and phone bookings. |
| **Admin** | Everything ops does, plus staff accounts, clinics, services and prices, and the audit log. |

## How it works

- **Auto-dispatch.** Every booking is offered to staff who have the service's skill, are on shift for the whole visit, are free (counting realistic city travel time between jobs) and are under their daily cap. Clinic visits go only to staff based at that clinic. The cheapest option wins, where cost = travel minutes + 15 minutes per job already assigned that day, which spreads the load. If nobody fits, the job waits in the ops queue with the reason for each person ("not on shift", "would be late for the next job", …), and ops can override.
- **Job lifecycle.** `requested → assigned → en_route → arrived → in_progress → completed`, plus `cancelled` and `no_show`. Each transition is checked for role, ownership and order. Patients can cancel only until the caregiver leaves. Clinic visits skip the trip. Deliveries complete on handover with the OTP. Every step is timestamped (with GPS when the phone allows) in the job timeline.
- **Clinical safety.** Vitals use LOINC codes and are checked for plausibility. Readings in dangerous ranges (e.g. BP ≥ 180/120, glucose < 54 or > 400 mg/dL, SpO₂ < 90 %, HR > 130 or < 40) raise **critical alerts** that appear instantly for ops. An alert can only be closed with a written resolution. These thresholds flag readings for human review; they do not replace clinical judgment.
- **Privacy and accountability.** Patients consent at sign-up. Staff see only the jobs assigned to them, with need-to-know patient details. Only the patient sees the delivery OTP. Every mutation, login, failed OTP and record view goes into an **append-only audit log**: the database itself rejects edits and deletes. Disabling a staff account cuts off access immediately.
- **Notifications.** Patients, staff and on-call dispatchers get SMS or WhatsApp messages:
  - **patients:** booking confirmed, who is coming, "on the way, arriving in about N min" (with the delivery code), visit completed, cancellations;
  - **staff:** new job, job moved or cancelled;
  - **every dispatcher and admin:** a page for each **critical** reading.

  Every message goes to an outbox first (the *Messages* tab), so you can see exactly what was sent and what failed. A failed send never blocks a booking. With no provider configured, messages are recorded but not sent.
- **Live location and ETA.** While a caregiver or courier is on the way, their phone shares its location every 30 seconds, and only then. The patient sees "Arriving in about N min", and dispatchers see staff and open jobs on the *Map* tab (OpenStreetMap).
- **Money.** Prices are in paise. A price change applies to new bookings only. Staff record payment at completion (cash, UPI, card, insurance). The board shows the amount collected and the on-time arrival rate.

## Run it on your computer (5 minutes)

Requires Node.js 20 or newer.

```sh
cd platform
npm install
npm run build
SEED_DEMO=1 npm start          # Windows PowerShell: $env:SEED_DEMO=1; npm start
```

Open http://localhost:8787. The demo data includes two Pune clinics, a dispatcher, seven caregivers, two couriers, three patients and 14 days of shifts. Every demo password is `changeme123`.

| Log in as | Phone |
|---|---|
| Admin | 9000000001 |
| Dispatcher | 9000000002 |
| Nurse (Anita) | 9100000001 |
| Courier (Sagar) | 9200000001 |
| Patient (Sunita) | 9300000001 |

## Go live

1. **Deploy.** The repo includes a Render blueprint (`render.yaml`): create a Render account, choose *New → Blueprint*, and pick this repository. It builds the Docker image and attaches a 1 GB persistent disk for the database (paid "Starter" instance, about $7/month plus disk). Any Docker host works the same way (`platform/Dockerfile`; keep `/data` on a persistent volume).
2. **Set environment variables on the host**, never in code:
   - `SESSION_SECRET`: 32+ random bytes (Render generates it).
   - `ADMIN_PHONE` and `ADMIN_PASSWORD` (12+ characters): on first start, the server creates this admin and the default service catalog.
   - SMS/WhatsApp via Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (a Twilio number, or `whatsapp:+…` for an approved WhatsApp sender), and `NOTIFY_CHANNEL=sms|whatsapp`. In India, commercial SMS also requires DLT registration of your sender ID and templates through your provider.
   - optional: `CORS_ORIGIN` (default: allow all), `PORT` (default 8787).
3. **First login as admin:**
   - *Setup*: add your clinics, then adjust services and prices.
   - *Staff*: create an account for each caregiver, courier and dispatcher, with their skills and home location (latitude/longitude), then add their shifts.
   - Share the temporary passwords privately.
4. **Back up the database daily.** It's a single SQLite file at `/data/care.db`. Use your host's disk snapshots, or stream it to cloud storage with Litestream.

## Before serving real patients (India)

The software handles operations. These obligations are yours, and you should check them with a lawyer or compliance adviser:
- **Data protection:** the Digital Personal Data Protection Act 2023 requires a privacy notice, consent (captured at sign-up), purpose limitation, breach notification and data-principal rights. The audit log helps with accountability.
- **Clinical staff:** keep each caregiver's registration number (the "licence" field) and verify it with the state council.
- **Medicine delivery:** deliveries must come from a licensed pharmacy under the Drugs and Cosmetics Act. Prescription medicines need a valid prescription; collect and check it.
- **Emergencies:** alerts reach your team, but they are not an emergency service. Have a written escalation protocol (who calls the patient, when to call 108) and train staff on it.
- **Medical device rules:** don't claim diagnosis or dosing. The product flags readings for human review.

## Development

```sh
npm run dev           # API on :8787 with reload
npm run dev:web       # web app on :5173, proxying /api
npm test              # 33 unit and API tests (in-memory SQLite)
npm run e2e           # 6 browser flows (desktop and phone)
```

Code map: `src/domain/` holds the pure rules (dispatch, lifecycle, vitals); `src/notify.ts` holds the message rules and providers. `src/app.ts` is the HTTP API. `src/schema.sql` is the database. `web/src/` holds the role-based UI.
