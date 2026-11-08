import './ui/styles.css';
import { demo, landing } from './ui/views';
import { vaultView } from './ui/vault-view';
import { logView } from './ui/log-view';

const app = document.getElementById('app')!;

function applyTheme(t: 'light' | 'dark') {
  document.documentElement.dataset['theme'] = t;
  try {
    localStorage.setItem('steadyline.theme', t);
  } catch {
    /* storage may be unavailable (private mode); theme just won't persist */
  }
}

function initialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem('steadyline.theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* ignore */
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset['theme'] === 'dark' ? 'light' : 'dark');
}

function render() {
  app.replaceChildren(
    location.hash.startsWith('#/demo')
      ? demo()
      : location.hash.startsWith('#/vault')
        ? vaultView()
        : location.hash.startsWith('#/log')
          ? logView()
          : landing(),
  );
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
  window.scrollTo(0, 0);
}

applyTheme(initialTheme());
window.addEventListener('hashchange', render);
window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 't') toggleTheme();
  if (e.key === 'd') location.hash = '#/demo';
  if (e.key === 'h') location.hash = '#/';
});
render();
