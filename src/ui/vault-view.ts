import { h } from './dom';
import { IdbStore } from '../storage/raw-store';
import { Vault, WrongPassphraseError } from '../storage/vault';

/** The single unlocked vault for this tab; cleared by Lock. */
let active: Vault | undefined;
export const currentVault = () => (active && !active.locked ? active : undefined);

/** Lock / unlock screen. Creates the vault on first use. */
export function vaultView(): HTMLElement {
  const store = new IdbStore();
  const status = h('p', { role: 'status', 'aria-live': 'polite' });
  const form = h('form', { class: 'card', novalidate: true });
  const body = h(
    'main',
    { id: 'main', tabindex: '-1' },
    h('h1', {}, 'Your private vault'),
    form,
    status,
  );

  const say = (msg: string, error = false) => {
    status.textContent = msg;
    status.className = error ? 'err' : '';
  };

  const render = async () => {
    const open = currentVault();
    if (open) {
      const n = await open.count();
      form.replaceChildren(
        h('p', {}, `Unlocked. ${n} encrypted record${n === 1 ? '' : 's'} on this device.`),
        h('a', { href: '#/log', class: 'btn' }, 'Open the log'),
        h('a', { href: '#/import', class: 'btn' }, 'Import data'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Lock now'),
      );
      form.onsubmit = (e) => {
        e.preventDefault();
        open.lock();
        active = undefined;
        say('Locked. Keys were removed from memory.');
        void render();
      };
      return;
    }
    const exists = await Vault.exists(store);
    const input = h('input', {
      id: 'passphrase',
      type: 'password',
      autocomplete: exists ? 'current-password' : 'new-password',
      required: true,
      'aria-describedby': 'pp-help',
    }) as HTMLInputElement;
    form.replaceChildren(
      h('label', { for: 'passphrase' }, exists ? 'Passphrase' : 'Choose a passphrase'),
      input,
      h(
        'p',
        { id: 'pp-help', class: 'muted' },
        exists
          ? 'Your data is encrypted with this passphrase on this device.'
          : 'At least 8 characters. There is no account and no recovery: if you forget it, the data cannot be read. Export a backup.',
      ),
      h('button', { type: 'submit', class: 'btn primary' }, exists ? 'Unlock' : 'Create vault'),
    );
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        active = exists
          ? await Vault.unlock(store, input.value)
          : await Vault.create(store, input.value);
        say(exists ? 'Unlocked.' : 'Vault created.');
        await render();
      } catch (err) {
        say(
          err instanceof WrongPassphraseError ? 'Wrong passphrase.' : (err as Error).message,
          true,
        );
        input.select();
      }
    };
  };
  void render();
  return h('div', {}, body);
}
