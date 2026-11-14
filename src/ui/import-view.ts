import { h } from './dom';
import { currentVault } from './vault-view';
import { decodeStream } from '../importers/xml';
import { runImport, storedKeys, type ImportOutcome } from '../importers/run';
import type { Observation, Patient } from '../domain/fhir';

const KIND_LABEL = {
  applehealth: 'Apple Health export',
  cgm: 'CGM CSV (Dexcom / Libre)',
  vitals: 'Vitals CSV (Google Fit / Health Connect)',
} as const;

/** Import screen: pick a file, watch progress, cancel, review the report, then save. */
export function importView(): HTMLElement {
  const main = h('main', { id: 'main', tabindex: '-1' }, h('h1', {}, 'Import data'));
  const vault = currentVault();
  if (!vault) {
    main.append(
      h('p', {}, 'Unlock your vault first. '),
      h('a', { href: '#/vault' }, 'Go to vault'),
    );
    return main;
  }
  const file = h('input', {
    id: 'file',
    type: 'file',
    accept: '.csv,.xml,text/csv,text/xml',
  }) as HTMLInputElement;
  const offset = h('input', {
    id: 'offset',
    type: 'number',
    value: '0',
    step: '15',
    min: '-720',
    max: '840',
  }) as HTMLInputElement;
  const order = h(
    'select',
    { id: 'order' },
    h('option', { value: 'dmy' }, 'Day first (31/12/2026)'),
    h('option', { value: 'mdy' }, 'Month first (12/31/2026)'),
  ) as HTMLSelectElement;
  const start = h('button', { type: 'submit', class: 'btn' }, 'Read file') as HTMLButtonElement;
  const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel') as HTMLButtonElement;
  cancel.hidden = true;
  const bar = h('progress', { max: '1', 'aria-label': 'Import progress' }) as HTMLProgressElement;
  bar.hidden = true;
  const status = h('p', { role: 'status', 'aria-live': 'polite' });
  const result = h('div', {});

  const say = (m: string, err = false) => {
    status.textContent = m;
    status.className = err ? 'err' : '';
  };

  let patient: Patient | undefined;
  let pending: ImportOutcome | undefined;

  const showResult = (o: ImportOutcome) => {
    pending = o;
    const rows = [
      `Rows/records read: ${o.read}`,
      `New: ${o.imported}`,
      `Already stored (skipped): ${o.duplicates}`,
      ...o.notes,
    ];
    const list = h('ul', {}, ...rows.map((r) => h('li', {}, r)));
    const errs = h(
      'details',
      {},
      h('summary', {}, `${o.errors.length + o.errorsTruncated} problem(s)`),
      h(
        'ul',
        {},
        ...o.errors.map((e) => h('li', {}, `Line ${e.line}: ${e.reason}`)),
        o.errorsTruncated ? h('li', {}, `…and ${o.errorsTruncated} more`) : null,
      ),
    );
    const total = o.observations.length + o.glucose.length;
    const save = h('button', { type: 'button', class: 'btn' }, `Save ${total} readings`);
    save.hidden = total === 0;
    save.onclick = async () => {
      save.setAttribute('disabled', '');
      await vault.putMany(pending!.observations);
      await vault.putCgm(pending!.glucose);
      say(`Saved ${total} readings to your vault.`);
      result.replaceChildren();
    };
    const parts: (HTMLElement | null)[] = [
      h('h2', {}, o.kind ? KIND_LABEL[o.kind] : 'Unrecognised file'),
      list,
      o.errors.length + o.errorsTruncated ? errs : null,
      save,
    ];
    result.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
  };

  const form = h(
    'form',
    { class: 'card', novalidate: true },
    h('label', { for: 'file' }, 'Export file (CSV or Apple Health export.xml)'),
    file,
    h('label', { for: 'offset' }, 'Device clock offset from UTC, minutes (CSV only; India is 330)'),
    offset,
    h('label', { for: 'order' }, 'Date order for ambiguous dates (CSV only)'),
    order,
    h('div', {}, start, cancel),
    bar,
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = file.files?.[0];
    if (!f) return say('Choose a file first.', true);
    result.replaceChildren();
    const ac = new AbortController();
    cancel.hidden = false;
    cancel.onclick = () => ac.abort();
    start.setAttribute('disabled', '');
    bar.hidden = false;
    bar.removeAttribute('value');
    say('Reading…');
    try {
      patient ??= (await vault.query<Patient>('Patient'))[0];
      if (!patient) return say('Set up your profile on the Log screen first.', true);
      const existing = storedKeys(await vault.query<Observation>('Observation'));
      for (const g of await vault.cgm()) existing.add(`glucose@${g.t}`);
      const o = await runImport(() => decodeStream(f.stream()), {
        patientId: patient.id,
        existingKeys: existing,
        utcOffsetMinutes: Number(offset.value) || 0,
        dateOrder: order.value as 'dmy' | 'mdy',
        signal: ac.signal,
        onProgress: (n) => {
          bar.value = Math.min(1, n / Math.max(1, f.size));
        },
      });
      say(
        o.cancelled ? 'Cancelled. Nothing was saved.' : 'Done reading. Review, then save.',
        false,
      );
      if (!o.cancelled) showResult(o);
    } catch (err) {
      say(`Import failed: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      bar.hidden = true;
      cancel.hidden = true;
      start.removeAttribute('disabled');
    }
  };

  main.append(
    h('p', { class: 'muted' }, 'Files are read in your browser and never uploaded.'),
    form,
    status,
    result,
  );
  return main;
}
