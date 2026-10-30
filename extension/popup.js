const $ = (id) => document.getElementById(id);
const DEFAULTS = { subfolder: 'Telegram', parallel: 2, includeDownloaded: false };
let settings = { ...DEFAULTS };
let tab = null;
let last = null;

const saveSettings = () => chrome.storage.local.set({ settings });

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}

function fmtBytes(n) {
  if (!n) return '0 MB';
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

function secs(label) {
  const m = /(\d{1,2}(?::\d{2}){1,2})/.exec(label || '');
  return m ? m[1].split(':').map(Number).reduce((a, b) => a * 60 + b, 0) : 0;
}
function fmtDur(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}

// ---------- tabs ----------

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === name));
}

// ---------- talking to the Telegram tab ----------

async function send(type, data = {}) {
  if (!tab) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type, ...data });
  } catch {
    return null;
  }
}

// ---------- videos ----------

let itemsSig = '';
function renderItems(s) {
  const items = s.items;
  $('chatName').textContent = s.chat;
  $('appVer').textContent = 'Web ' + s.app;
  const sel = items.filter((i) => i.selected);
  const total = sel.reduce((a, i) => a + secs(i.label), 0);
  $('cntSel').textContent = sel.length || '';
  $('start').disabled = !sel.length;
  $('start').textContent = sel.length ? `Download (${sel.length})` + (total ? ` · ${fmtDur(total)}` : '') : 'Download';
  const free = items.filter((i) => !i.prot && !i.queued && (settings.includeDownloaded || !i.downloaded) && !i.selected).length;
  $('selAll').textContent = `Select all (${free})`;
  $('selAll').disabled = !free;
  $('selClear').disabled = !sel.length;
  $('emptyItems').style.display = items.length ? 'none' : 'block';

  const sig = JSON.stringify(items.map((i) => [i.key, i.label, i.sub, i.selected, i.downloaded, i.queued, i.prot]));
  if (sig === itemsSig) return;
  itemsSig = sig;
  const list = $('itemList');
  list.textContent = '';
  for (const i of items) {
    const box = el('input', { type: 'checkbox', checked: i.selected, disabled: i.prot || i.queued });
    const row = el('label', { class: 'item' + (i.prot ? ' prot' : ''), title: i.prot ? 'Saving is disabled in this chat' : '' },
      box,
      el('div', { class: 'txt' },
        el('div', { class: 'lbl' }, i.label),
        el('div', { class: 'sub' }, i.sub || '')),
      i.prot ? el('span', { class: 'tag lock' }, 'LOCKED')
        : i.queued ? el('span', { class: 'tag q' }, 'QUEUED')
        : i.downloaded ? el('span', { class: 'tag dl', title: 'Already downloaded' }, 'DOWNLOADED') : null);
    box.addEventListener('change', async () => {
      const r = await send('toggle', { key: i.key });
      if (r) update(r);
    });
    list.append(row);
  }
}

$('selAll').addEventListener('click', async () => { const r = await send('selectAll', { includeDownloaded: settings.includeDownloaded }); if (r) update(r); });
$('selClear').addEventListener('click', async () => { const r = await send('clear'); if (r) update(r); });
$('start').addEventListener('click', async () => { const r = await send('start'); if (r) { update(r); showTab('downloads'); } });
$('openTg').addEventListener('click', () => chrome.tabs.create({ url: 'https://web.telegram.org/' }));
$('inclDone').addEventListener('change', () => {
  settings.includeDownloaded = $('inclDone').checked;
  saveSettings();
  if (last) renderItems(last);
});

// ---------- downloads ----------

const ERRORS = {
  NETWORK_FAILED: 'Network error', FILE_NO_SPACE: 'Disk is full', FILE_FAILED: 'Could not write the file',
  SERVER_FAILED: 'Telegram server error', FILE_ACCESS_DENIED: 'No permission to write to the folder',
};

let jobsSig = '';
async function renderJobs(s) {
  const jobs = s.jobs;
  const running = jobs.filter((j) => ['waiting', 'starting', 'started', 'downloading'].includes(j.status)).length;
  $('cntJobs').textContent = running || '';
  $('emptyJobs').style.display = jobs.length ? 'none' : 'block';
  $('jobFooter').style.display = jobs.length ? '' : 'none';

  const sig = JSON.stringify(jobs.map((j) => [j.key, j.status, j.dlId, j.error]));
  const list = $('jobList');
  if (sig !== jobsSig) {
    jobsSig = sig;
    list.textContent = '';
    for (const j of [...jobs].reverse()) {
      const actions = el('div', { class: 'actions' });
      if (j.status === 'done' && j.dlId !== null) {
        actions.append(el('button', { class: 'btn small ghost', onclick: () => chrome.downloads.show(j.dlId) }, 'Show in folder'));
      }
      if (['failed', 'skipped', 'canceled'].includes(j.status)) {
        actions.append(el('button', { class: 'btn small ghost', onclick: async () => { const r = await send('retry', { key: j.key }); if (r) update(r); } }, 'Retry'));
      }
      list.append(el('div', { class: 'card job ' + (j.status === 'done' ? 'done' : ['failed', 'skipped'].includes(j.status) ? 'error' : j.status), 'data-key': j.key },
        el('div', { class: 'title' }, j.label + (j.sub ? ' · ' + j.sub : '')),
        el('div', { class: 'meta-chat' }, j.chat || ''),
        el('div', { class: 'progress' }, el('div')),
        el('div', { class: 'status' }, el('span', { class: 'left' }), el('span', { class: 'right' })),
        el('div', { class: 'error' }, j.error ? (ERRORS[j.error] || j.error) : ''),
        actions));
    }
  }

  // live progress straight from Brave's download manager
  for (const j of jobs) {
    const card = list.querySelector(`.job[data-key="${CSS.escape(j.key)}"]`);
    if (!card) continue;
    let pct = j.status === 'done' ? 100 : 0, left = j.statusText || j.status, right = '';
    if (j.dlId !== null) {
      const [d] = await chrome.downloads.search({ id: j.dlId }).catch(() => []);
      if (d) {
        if (d.totalBytes > 0) pct = j.status === 'done' ? 100 : (d.bytesReceived / d.totalBytes) * 100;
        right = d.totalBytes > 0 && j.status !== 'done' ? `${fmtBytes(d.bytesReceived)} / ${fmtBytes(d.totalBytes)}` : fmtBytes(d.fileSize || d.bytesReceived);
        if (j.status === 'downloading' && d.totalBytes > 0) left += ` ${pct.toFixed(0)}%`;
      }
    }
    card.querySelector('.progress > div').style.width = pct.toFixed(1) + '%';
    card.querySelector('.left').textContent = left;
    card.querySelector('.right').textContent = right;
  }
}

$('stopQueue').addEventListener('click', async () => { const r = await send('stopQueue'); if (r) update(r); });
$('cleanJobs').addEventListener('click', async () => { const r = await send('cleanFinished'); if (r) update(r); });

// ---------- update loop ----------

function update(s) {
  last = s;
  $('notTelegram').style.display = 'none';
  $('tgView').style.display = '';
  renderItems(s);
  renderJobs(s);
}

async function poll() {
  const s = await send('getState');
  if (!s) {
    $('notTelegram').style.display = 'block';
    $('tgView').style.display = 'none';
    $('emptyJobs').style.display = 'block';
    $('jobFooter').style.display = 'none';
    return;
  }
  update(s);
}

// ---------- settings ----------

async function showHistory() {
  const { history = {} } = await chrome.storage.local.get('history');
  $('histCount').textContent = `${Object.keys(history).length} video(s) remembered as downloaded`;
}

function bindSettings() {
  $('setFolder').value = settings.subfolder;
  $('setPar').value = settings.parallel;
  $('setParNum').value = settings.parallel;
  $('inclDone').checked = settings.includeDownloaded;
  $('setFolder').addEventListener('change', () => { settings.subfolder = $('setFolder').value.trim(); saveSettings(); });
  const setPar = (v) => {
    v = Math.max(1, Math.min(5, Math.round(Number(v) || DEFAULTS.parallel)));
    settings.parallel = v; $('setPar').value = v; $('setParNum').value = v; saveSettings();
  };
  $('setPar').addEventListener('input', () => setPar($('setPar').value));
  $('setParNum').addEventListener('change', () => setPar($('setParNum').value));
  // No value changes by mouse wheel.
  for (const id of ['setPar', 'setParNum']) $(id).addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  $('histClear').addEventListener('click', async () => {
    if (!confirm('Forget which videos were already downloaded?')) return;
    await chrome.storage.local.set({ history: {} });
    showHistory();
  });
}

(async () => {
  const st = await chrome.storage.local.get('settings');
  settings = { ...DEFAULTS, ...(st.settings || {}) };
  bindSettings();
  showHistory();
  const forced = Number(new URLSearchParams(location.search).get('tab')); // used for testing the popup in a tab
  [tab] = forced ? [{ id: forced }] : await chrome.tabs.query({ active: true, currentWindow: true });
  await poll();
  setInterval(poll, 800);
})();
