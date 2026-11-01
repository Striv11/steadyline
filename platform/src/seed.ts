/**
 * First-run data.
 *  - bootstrap(): production start: the admin account (ADMIN_PHONE / ADMIN_PASSWORD)
 *    and the default priced service catalog. Run automatically by the server on an
 *    empty database when those variables are set.
 *  - demo(): a complete working example: two Pune clinics, dispatcher, caregivers
 *    and couriers with skills and 14 days of shifts, and demo patients
 *    (password SEED_PASSWORD, default changeme123; local/testing only).
 * Both only act on an empty database.
 */
import { pathToFileURL } from 'node:url';
import { hashPassword } from './auth.js';
import { audit, id, now, openDb, type DB } from './db.js';

const isEmpty = (db: DB) =>
  (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n === 0;

const SERVICES: [string, string, string, number, number, string][] = [
  [
    'home_visit',
    'Nursing visit (vitals, care review)',
    'nursing',
    45,
    79900,
    'A registered nurse checks vitals, reviews medicines and symptoms, and updates your care record.',
  ],
  [
    'home_visit',
    'Injection at home',
    'nursing',
    30,
    49900,
    'Prescribed injection (insulin start, B12, antibiotics). Prescription required.',
  ],
  [
    'home_visit',
    'Wound care / dressing',
    'nursing',
    45,
    69900,
    'Cleaning and dressing of wounds, ulcers or surgical sites.',
  ],
  [
    'home_visit',
    'Physiotherapy session',
    'physio',
    60,
    99900,
    'Mobility, pain and rehab exercises at home with a licensed physiotherapist.',
  ],
  [
    'home_visit',
    'Blood sample collection',
    'phlebotomy',
    20,
    29900,
    'Sample drawn at home and taken to the partner lab.',
  ],
  [
    'home_visit',
    'Elder care attendant (4 hours)',
    'attendant',
    240,
    149900,
    'Help with bathing, meals, mobility and companionship.',
  ],
  [
    'clinic_visit',
    'Chronic care consultation',
    'doctor',
    30,
    59900,
    'Review with a doctor at the clinic: results, medicines, plan.',
  ],
  [
    'clinic_visit',
    'Diabetes education session',
    'nursing',
    45,
    39900,
    'Glucose monitoring, insulin technique, food and hypo management.',
  ],
  [
    'delivery',
    'Medicine & supplies delivery',
    'delivery',
    30,
    4900,
    'Delivered from a licensed partner pharmacy. Prescription medicines require a valid prescription.',
  ],
];

function insertServices(db: DB) {
  for (const [kind, name, skill, dur, price, desc] of SERVICES)
    db.prepare(
      'INSERT INTO services (id, name, kind, skill, duration_min, price_paise, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id('svc'), name, kind, skill, dur, price, desc);
}

export function bootstrap(db: DB, adminPhone: string, adminPassword: string): boolean {
  if (!isEmpty(db)) return false;
  if (adminPassword.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  db.transaction(() => {
    db.prepare(
      'INSERT INTO users (id, role, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id('usr'), 'admin', 'Admin', adminPhone, hashPassword(adminPassword), now());
    insertServices(db);
    audit(db, null, 'bootstrap', 'database', null);
  })();
  return true;
}

export function demo(db: DB): boolean {
  if (!isEmpty(db)) return false;
  const pw = hashPassword(process.env['SEED_PASSWORD'] ?? 'changeme123');
  const t = now();

  const user = (role: string, name: string, phone: string) => {
    const uid = id('usr');
    db.prepare(
      'INSERT INTO users (id, role, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(uid, role, name, phone, pw, t);
    return uid;
  };

  db.transaction(() => {
    const kothrud = id('site');
    const viman = id('site');
    db.prepare('INSERT INTO sites VALUES (?, ?, ?, ?, ?, ?)').run(
      kothrud,
      'Kothrud Care Clinic',
      'Paud Road, Kothrud, Pune 411038',
      18.5074,
      73.8077,
      'clinic',
    );
    db.prepare('INSERT INTO sites VALUES (?, ?, ?, ?, ?, ?)').run(
      viman,
      'Viman Nagar Care Clinic',
      'Nagar Road, Viman Nagar, Pune 411014',
      18.5679,
      73.9143,
      'clinic',
    );

    insertServices(db);

    user('admin', 'Admin', '9000000001');
    user('ops', 'Dispatcher', '9000000002');

    const staff: [
      string,
      string,
      string,
      string[],
      number,
      number,
      string | null,
      string | null,
    ][] = [
      [
        'caregiver',
        'Anita Kulkarni (RN)',
        '9100000001',
        ['nursing', 'phlebotomy'],
        18.515,
        73.83,
        null,
        'MNC-RN-102345',
      ],
      [
        'caregiver',
        'Rahul Deshmukh (RN)',
        '9100000002',
        ['nursing'],
        18.56,
        73.91,
        null,
        'MNC-RN-118822',
      ],
      [
        'caregiver',
        'Sneha Patil (PT)',
        '9100000003',
        ['physio'],
        18.53,
        73.85,
        null,
        'MSCPT-55621',
      ],
      ['caregiver', 'Imran Shaikh', '9100000004', ['attendant'], 18.5, 73.86, null, null],
      ['caregiver', 'Priya Joshi', '9100000005', ['phlebotomy'], 18.59, 73.79, null, 'DMLT-7781'],
      [
        'caregiver',
        'Dr. Meera Rao',
        '9100000006',
        ['doctor'],
        18.51,
        73.81,
        'kothrud',
        'MMC-2011-04567',
      ],
      [
        'caregiver',
        'Kavita Nair (RN)',
        '9100000007',
        ['nursing'],
        18.57,
        73.91,
        'viman',
        'MNC-RN-120001',
      ],
      ['courier', 'Sagar More', '9200000001', ['delivery'], 18.52, 73.84, null, null],
      ['courier', 'Vikas Pawar', '9200000002', ['delivery'], 18.565, 73.9, null, null],
    ];
    for (const [role, name, phone, skills, lat, lng, site, lic] of staff) {
      const uid = user(role, name, phone);
      db.prepare(
        'INSERT INTO staff (user_id, skills, license, home_lat, home_lng, site_id) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        uid,
        JSON.stringify(skills),
        lic,
        lat,
        lng,
        site === 'kothrud' ? kothrud : site === 'viman' ? viman : null,
      );
      // 08:00–20:00 IST (02:30–14:30 UTC) for the next 14 days, starting today.
      for (let d = 0; d < 14; d++) {
        const day = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
        db.prepare('INSERT INTO shifts (id, staff_id, starts_at, ends_at) VALUES (?, ?, ?, ?)').run(
          id('shf'),
          uid,
          `${day}T02:30:00.000Z`,
          `${day}T14:30:00.000Z`,
        );
      }
    }

    const patients: [string, string, string, number, number, string[], string[]][] = [
      [
        'Sunita Bhosale',
        '9300000001',
        'Flat 4, Shanti Apts, Karve Nagar, Pune 411052',
        18.488,
        73.818,
        ['type 2 diabetes', 'hypertension'],
        ['penicillin'],
      ],
      [
        'Ramesh Iyer',
        '9300000002',
        '12 Lane 5, Koregaon Park, Pune 411001',
        18.536,
        73.893,
        ['heart failure', 'chronic kidney disease'],
        [],
      ],
      [
        'Farida Khan',
        '9300000003',
        'B-203 Green Woods, Kharadi, Pune 411014',
        18.551,
        73.94,
        ['COPD'],
        ['sulfa drugs'],
      ],
    ];
    for (const [name, phone, addr, lat, lng, cond, all] of patients) {
      const uid = user('patient', name, phone);
      db.prepare(
        'INSERT INTO patients (user_id, conditions, allergies, address, lat, lng, consent_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(uid, JSON.stringify(cond), JSON.stringify(all), addr, lat, lng, t);
    }
    audit(db, null, 'seed', 'database', null);
  })();
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const ok = demo(openDb());
  console.log(
    ok
      ? 'Demo data seeded. Logins are in src/seed.ts; password is SEED_PASSWORD (default changeme123).'
      : 'Database already has users; not seeding.',
  );
}
