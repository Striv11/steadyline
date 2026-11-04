import { h } from './dom';
import { glucoseChart, tirBar } from './charts';
import { generateSyntheticPatient } from '../sim/generator';
import { computeGlucoseMetrics, TARGETS } from '../metrics/glucose';
import { CONDITIONS } from '../domain/codes';

export const DISCLAIMER =
  'Steadyline is a personal tracking tool. It is not medical advice and not a diagnostic device. It never recommends doses or diagnoses. Talk to your care team about your treatment.';

function nav(current: 'home' | 'demo'): HTMLElement {
  return h(
    'header',
    { class: 'topbar' },
    h(
      'a',
      { class: 'brand', href: '#/' },
      h('span', { class: 'logo', 'aria-hidden': 'true' }, '〰'),
      'Steadyline',
    ),
    h(
      'nav',
      { 'aria-label': 'Main' },
      h('a', { href: '#/', ...(current === 'home' ? { 'aria-current': 'page' } : {}) }, 'Home'),
      h('a', { href: '#/demo', ...(current === 'demo' ? { 'aria-current': 'page' } : {}) }, 'Demo'),
      h('a', { href: '#/vault' }, 'Vault'),
      h(
        'button',
        {
          type: 'button',
          id: 'theme-toggle',
          class: 'btn ghost',
          'aria-label': 'Toggle light/dark theme',
          title: 'Theme (T)',
        },
        '◐',
      ),
    ),
  );
}

function footer(): HTMLElement {
  return h(
    'footer',
    { class: 'foot' },
    h('p', { class: 'disclaimer', role: 'note' }, DISCLAIMER),
    h('p', {}, 'Local-first: data stays on your device. No accounts, no server, no tracking.'),
  );
}

export function landing(): HTMLElement {
  const features = [
    [
      'Private by design',
      'Stored in IndexedDB on your device, encrypted with a passphrase you choose (AES-GCM). No server, no account.',
    ],
    [
      'Log in under 5 seconds',
      'Keyboard-first quick-add for vitals, symptoms, meds, sleep, mood and triggers, with templates per condition.',
    ],
    [
      'Clinically grounded',
      'Time-in-range, GMI and CV per international consensus; BP categories per ACC/AHA 2017; adherence as PDC.',
    ],
    [
      'Honest insights',
      'Correlations show sample size and always say “association is not causation”.',
    ],
    [
      'Visit-ready reports',
      'One click makes a printable 30/90-day summary for your clinician, with your own questions.',
    ],
    [
      'Open standards',
      'Built on FHIR R4 with LOINC codes. Import and export FHIR Bundles; bring CSV and Apple Health data.',
    ],
  ];
  return h(
    'div',
    {},
    nav('home'),
    h(
      'main',
      { id: 'main', tabindex: '-1' },
      h(
        'section',
        { class: 'hero' },
        h('p', { class: 'eyebrow' }, 'Chronic condition tracking, kept on your device'),
        h('h1', {}, 'See your health trends. Keep your health private.'),
        h(
          'p',
          { class: 'lede' },
          'Steadyline turns everyday readings, symptoms and medications into clear, clinically grounded views for diabetes, hypertension, asthma, migraine and more, without ever uploading a byte.',
        ),
        h(
          'div',
          { class: 'cta' },
          h('a', { class: 'btn primary', href: '#/demo' }, 'Try the demo patient'),
          h('a', { class: 'btn', href: 'https://github.com/Striv11/steadyline' }, 'View source'),
        ),
        h(
          'p',
          { class: 'fine' },
          'The demo uses a clearly synthetic patient generated in your browser.',
        ),
      ),
      h(
        'section',
        { 'aria-labelledby': 'feat' },
        h('h2', { id: 'feat' }, 'Built for people living with a long-term condition'),
        h(
          'ul',
          { class: 'grid features' },
          ...features.map(([t, d]) => h('li', { class: 'card' }, h('h3', {}, t!), h('p', {}, d!))),
        ),
      ),
      h(
        'section',
        { 'aria-labelledby': 'cond' },
        h('h2', { id: 'cond' }, 'Conditions'),
        h('ul', { class: 'chips' }, ...Object.values(CONDITIONS).map((c) => h('li', {}, c.label))),
      ),
    ),
    footer(),
  );
}

export function demo(): HTMLElement {
  const p = generateSyntheticPatient({ seed: 42, days: 14, start: '2026-10-01' });
  const pts = p.cgm.map((c) => ({ t: c.t, v: c.mgdl }));
  const m = computeGlucoseMetrics(p.cgm.map((c) => c.mgdl))!;
  const tile = (label: string, value: string, note: string) =>
    h(
      'li',
      { class: 'tile' },
      h('span', { class: 'tl' }, label),
      h('span', { class: 'tv' }, value),
      h('span', { class: 'tn' }, note),
    );
  const patient = p.resources.find((r) => r.resourceType === 'Patient');
  const name = patient && patient.resourceType === 'Patient' ? (patient.name?.[0]?.text ?? '') : '';
  return h(
    'div',
    {},
    nav('demo'),
    h(
      'main',
      { id: 'main', tabindex: '-1' },
      h(
        'p',
        { class: 'banner', role: 'status' },
        `Demo mode — ${name}. All data is simulated, not a real person.`,
      ),
      h('h1', {}, 'Dashboard'),
      h('p', { class: 'fine' }, 'Last 14 days · Type 2 diabetes · Hypertension · Migraine'),
      h(
        'section',
        { 'aria-labelledby': 'glu' },
        h('h2', { id: 'glu' }, 'Glucose'),
        h(
          'ul',
          { class: 'tiles' },
          tile('Time in range', `${m.tir.toFixed(0)}%`, `target > ${TARGETS.tirMin}%`),
          tile('GMI', `${m.gmiPercent.toFixed(1)}%`, 'glucose management indicator'),
          tile(
            'Mean',
            `${Math.round(m.meanMgdl)} mg/dL`,
            `${m.n.toLocaleString('en-US')} readings`,
          ),
          tile('Variability (CV)', `${m.cvPercent.toFixed(0)}%`, `target ≤ ${TARGETS.cvMax}%`),
        ),
        tirBar(m),
        glucoseChart(pts, 'Glucose over the last 14 days'),
        h(
          'p',
          { class: 'fine' },
          'Ranges and targets: Battelino et al., Diabetes Care 2019. GMI: Bergenstal et al., Diabetes Care 2018.',
        ),
      ),
      h(
        'section',
        { 'aria-labelledby': 'soon' },
        h('h2', { id: 'soon' }, 'Coming in later releases'),
        h(
          'p',
          { class: 'empty' },
          'Blood pressure, adherence, symptom calendar, insights and the doctor-visit report arrive over the next days. See the roadmap in the README.',
        ),
      ),
    ),
    footer(),
  );
}
