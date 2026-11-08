import { h } from './dom';
import { currentVault } from './vault-view';
import { CONDITIONS } from '../domain/codes';
import type { Patient } from '../domain/fhir';
import { onboard } from '../logging/onboarding';
import { parseQuickAdd } from '../logging/quickadd';

/** Onboarding (first run) and the quick-add log. Needs an unlocked vault. */
export function logView(): HTMLElement {
  const main = h('main', { id: 'main', tabindex: '-1' }, h('h1', {}, 'Log'));
  const vault = currentVault();
  if (!vault) {
    main.append(
      h('p', {}, 'Unlock your vault first. '),
      h('a', { href: '#/vault' }, 'Go to vault'),
    );
    return main;
  }
  const status = h('p', { role: 'status', 'aria-live': 'polite' });
  const say = (m: string, err = false) => {
    status.textContent = m;
    status.className = err ? 'err' : '';
  };

  const renderLog = (patient: Patient) => {
    const input = h('input', {
      id: 'qa',
      type: 'text',
      autocomplete: 'off',
      placeholder: 'g 112 · bp 128/82 · sym headache 6 · med metformin missed',
      'aria-describedby': 'qa-help',
    }) as HTMLInputElement;
    const recent = h('ul', { 'aria-label': 'Recent entries' });
    const form = h(
      'form',
      { class: 'card', novalidate: true },
      h('label', { for: 'qa' }, 'Quick add'),
      input,
      h(
        'p',
        { id: 'qa-help', class: 'muted' },
        'Press / to focus, Enter to save. g glucose, bp, w, hr, spo2, temp, pf, sym, med, sleep, mood, food, act, trig, note.',
      ),
    );
    form.onsubmit = async (e) => {
      e.preventDefault();
      const r = parseQuickAdd(input.value, { patientId: patient.id, at: new Date().toISOString() });
      if (!r.ok) return say(r.error, true);
      await vault.putMany(r.resources);
      recent.prepend(h('li', {}, r.summary));
      input.value = '';
      say(`Saved: ${r.summary}`);
    };
    main.replaceChildren(
      h('h1', {}, `Log for ${patient.name?.[0]?.text ?? 'you'}`),
      form,
      status,
      recent,
    );
    input.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!input.isConnected) return window.removeEventListener('keydown', onKey);
      if (e.key === '/' && document.activeElement !== input) {
        e.preventDefault();
        input.focus();
      }
    };
    window.addEventListener('keydown', onKey);
  };

  const renderOnboarding = () => {
    const name = h('input', {
      id: 'name',
      type: 'text',
      required: true,
      autocomplete: 'name',
    }) as HTMLInputElement;
    const dob = h('input', { id: 'dob', type: 'date', autocomplete: 'bday' }) as HTMLInputElement;
    const boxes = Object.values(CONDITIONS).map((c) => ({
      c,
      box: h('input', { type: 'checkbox', id: `c-${c.key}` }) as HTMLInputElement,
    }));
    const form = h(
      'form',
      { class: 'card', novalidate: true },
      h('label', { for: 'name' }, 'Name'),
      name,
      h('label', { for: 'dob' }, 'Date of birth (optional)'),
      dob,
      h(
        'fieldset',
        {},
        h('legend', {}, 'Conditions you track'),
        ...boxes.map(({ c, box }) => h('div', {}, box, h('label', { for: `c-${c.key}` }, c.label))),
      ),
      h('button', { type: 'submit', class: 'btn primary' }, 'Save and start logging'),
    );
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const { patient, conditions } = onboard({
          name: name.value,
          birthDate: dob.value,
          conditionKeys: boxes.filter((b) => b.box.checked).map((b) => b.c.key),
        });
        await vault.putMany([patient, ...conditions]);
        renderLog(patient);
      } catch (err) {
        say((err as Error).message, true);
      }
    };
    main.replaceChildren(h('h1', {}, 'Welcome'), form, status);
  };

  void (async () => {
    const [patient] = await vault.query<Patient>('Patient');
    if (patient) renderLog(patient);
    else renderOnboarding();
  })();
  return main;
}
