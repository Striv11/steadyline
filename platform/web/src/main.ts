import './styles.css';
import { api, session, type User } from './api';
import { h, on, toast } from './dom';
import { opsView } from './ops';
import { patientView } from './patient';
import { staffView } from './staff';

const main = document.getElementById('main')!;
const nav = document.getElementById('nav')!;
let stop: (() => void) | null = null;

function render(): void {
  stop?.();
  stop = null;
  const s = session.get();
  nav.replaceChildren();
  if (!s) return void main.replaceChildren(welcome());
  nav.append(
    h('span', { class: 'who' }, `${s.user.name} · ${s.user.role}`),
    on(
      h('button', { class: 'btn ghost', type: 'button', 'data-testid': 'logout' }, 'Sign out'),
      'click',
      () => {
        session.clear();
        render();
      },
    ),
  );
  const view =
    s.user.role === 'patient'
      ? patientView
      : s.user.role === 'ops' || s.user.role === 'admin'
        ? opsView
        : staffView;
  stop = view(main, s.user);
}

function welcome(): HTMLElement {
  const mode = { register: false };
  const box = h('div', { class: 'auth card' });
  const draw = () => {
    const err = h('p', { class: 'error', role: 'alert' });
    const name = h('input', { id: 'name', autocomplete: 'name', required: true });
    const phone = h('input', {
      id: 'phone',
      type: 'tel',
      inputmode: 'numeric',
      autocomplete: 'tel',
      required: true,
      'data-testid': 'phone',
    });
    const pass = h('input', {
      id: 'pass',
      type: 'password',
      autocomplete: mode.register ? 'new-password' : 'current-password',
      required: true,
      'data-testid': 'password',
    });
    const consent = h('input', { id: 'consent', type: 'checkbox', 'data-testid': 'consent' });
    const form = h(
      'form',
      {},
      h('h2', {}, mode.register ? 'Create your patient account' : 'Sign in'),
      ...(mode.register ? [h('label', { for: 'name' }, 'Full name'), name] : []),
      h('label', { for: 'phone' }, 'Mobile number'),
      phone,
      h('label', { for: 'pass' }, 'Password'),
      pass,
      ...(mode.register
        ? [
            h(
              'label',
              { class: 'check' },
              consent,
              ' I agree that Steadyline Care may store my health information to arrange and record my care, and share it with the staff who serve me.',
            ),
          ]
        : []),
      err,
      h(
        'button',
        { class: 'btn primary wide', type: 'submit', 'data-testid': 'auth-submit' },
        mode.register ? 'Create account' : 'Sign in',
      ),
      on(
        h(
          'button',
          { class: 'btn link', type: 'button', 'data-testid': 'auth-switch' },
          mode.register ? 'I already have an account' : 'New patient? Create an account',
        ),
        'click',
        () => {
          mode.register = !mode.register;
          draw();
        },
      ),
      mode.register
        ? null
        : h('p', { class: 'fine' }, 'Staff accounts are created by your clinic administrator.'),
    );
    on(form, 'submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      try {
        const r = mode.register
          ? await api<{ token: string; user: User }>('POST', '/api/auth/register', {
              name: name.value,
              phone: phone.value.replace(/\s/g, ''),
              password: pass.value,
              consent: consent.checked || undefined,
            })
          : await api<{ token: string; user: User }>('POST', '/api/auth/login', {
              phone: phone.value.replace(/\s/g, ''),
              password: pass.value,
            });
        session.set(r);
        toast(`Welcome, ${r.user.name}`);
        render();
      } catch (x) {
        err.textContent = (x as Error).message;
      }
    });
    box.replaceChildren(form);
  };
  draw();
  return h(
    'div',
    { class: 'welcome' },
    h(
      'section',
      { class: 'hero' },
      h('p', { class: 'eyebrow' }, 'Home nursing · Clinic visits · Medicine delivery'),
      h('h1', {}, 'Care at home, run properly.'),
      h(
        'p',
        { class: 'lead' },
        'Book a nurse, physiotherapist, sample collection or medicine delivery in a minute. We send the nearest qualified person who is free, you track them live, and every reading they take goes into your record. Dangerous readings reach our clinical team immediately.',
      ),
      h(
        'ul',
        { class: 'points' },
        h('li', {}, h('strong', {}, 'Patients'), ' book, track and see their vitals.'),
        h(
          'li',
          {},
          h('strong', {}, 'Caregivers & couriers'),
          ' get their day, directions and a simple visit checklist on their phone.',
        ),
        h(
          'li',
          {},
          h('strong', {}, 'Clinic operations'),
          ' see every job live, fix gaps, and respond to alerts.',
        ),
      ),
    ),
    box,
  );
}

window.addEventListener('hashchange', () => main.focus({ preventScroll: true }));
render();
