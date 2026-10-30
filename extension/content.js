// Telegram Grabber - adds checkboxes to videos in Telegram Web (K and A versions) and downloads
// the selected ones one after another using Telegram's own "Download" action.
// The controls live in the extension popup; this script only marks videos and runs the queue.
(() => {
  if (window.__tggLoaded) return;
  window.__tggLoaded = true;

  const VIDEO_EXT = ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg'];
  const DL_WORDS = /^(download|herunterladen|скачать|завантажити|scarica|télécharger|descargar|baixar|pobierz|indir)\b/i;
  const START_TIMEOUT = 30 * 60 * 1000; // a job that never becomes a browser download is given up after 30 min
  const HISTORY_MAX = 20000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout = 2000, step = 60) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }
  const bg = (type, data = {}) => chrome.runtime.sendMessage({ target: 'background', type, ...data }).catch(() => null);
  const text = (el) => (el?.textContent || '').trim();
  const durationOk = (d) => /^\d{1,2}(:\d{2}){1,2}$/.test(d);

  // Same key for K and A: channel ids differ only by the "-100" prefix.
  function peerOf(raw) {
    let d = String(raw || '').replace(/[^0-9]/g, '');
    if (d.length >= 13 && d.startsWith('100')) d = d.slice(3);
    return d || 'x';
  }
  const keyOf = (peer, msgId, suffix = '') => `tg:${peerOf(peer)}:${msgId}${suffix}`;

  // ------------------------------------------------------------------ synthetic input

  function center(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 60)) };
  }
  function mouse(el, type, button, pos) {
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      button, buttons: type === 'mouseup' || type === 'click' ? 0 : (button === 2 ? 2 : 1),
      clientX: pos.x, clientY: pos.y, detail: type === 'contextmenu' ? 0 : 1,
    }));
  }
  function press(el) {
    const pos = center(el);
    mouse(el, 'mousedown', 0, pos); mouse(el, 'mouseup', 0, pos); mouse(el, 'click', 0, pos);
  }
  function rightClick(el) {
    const pos = center(el);
    mouse(el, 'mousedown', 2, pos); mouse(el, 'mouseup', 2, pos); mouse(el, 'contextmenu', 2, pos);
  }
  function escape() {
    for (const t of [document.activeElement || document.body, document]) {
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    }
  }

  // ------------------------------------------------------------------ Telegram Web K

  const K = {
    name: 'K',
    chatTitle() {
      return text(document.querySelector('.chat.active .top .peer-title')) || 'Telegram';
    },
    findItems() {
      const items = [];
      const scope = document.querySelector('.chat.active .bubbles') || document.querySelector('.bubbles');
      if (!scope) return items;
      for (const bubble of scope.querySelectorAll('.bubble[data-mid]')) {
        const peer = bubble.dataset.peerId || location.hash;
        const prot = bubble.classList.contains('no-forwards');
        const time = text(bubble.querySelector('.time-inner')) || '';

        if (bubble.classList.contains('video') && !bubble.classList.contains('round') && !bubble.classList.contains('is-album')) {
          const att = bubble.querySelector('.attachment');
          const dur = text(att?.querySelector('.video-time'));
          if (att && durationOk(dur)) {
            items.push({
              key: keyOf(peer, bubble.dataset.mid), host: att, prot, kind: 'video',
              target: () => att.querySelector('.media-video, .media-photo') || att,
              label: `Video ${dur}`, sub: time,
            });
          }
        }
        if (bubble.classList.contains('is-album')) {
          for (const gi of bubble.querySelectorAll('.grouped-item[data-mid]')) {
            const dur = text(gi.querySelector('.video-time'));
            if (!durationOk(dur)) continue;
            items.push({
              key: keyOf(peer, gi.dataset.mid), host: gi, prot, kind: 'video',
              target: () => gi.querySelector('.media-video, .media-photo') || gi,
              label: `Video ${dur}`, sub: time,
            });
          }
        }
        for (const doc of bubble.querySelectorAll('.document')) {
          const ext = ([...doc.classList].find((c) => c.startsWith('ext-')) || '').slice(4).toLowerCase();
          if (!VIDEO_EXT.includes(ext)) continue;
          const holder = doc.closest('[data-mid]');
          const nameEl = doc.querySelector('.document-name middle-ellipsis-element') || doc.querySelector('.document-name');
          const name = nameEl?.getAttribute('title') || text(nameEl) || `video.${ext}`;
          const size = text(doc.querySelector('.document-size')).split('/').pop().trim();
          items.push({
            key: keyOf(peer, holder?.dataset.mid || bubble.dataset.mid), host: doc, prot, kind: 'file',
            target: () => doc.querySelector('.document-ico') || doc,
            label: name, sub: size,
          });
        }
      }
      return items;
    },
    menuOpen() {
      const m = document.querySelector('#bubble-contextmenu');
      return m && m.classList.contains('active') ? m : null;
    },
    downloadButton(menu) {
      for (const it of menu.querySelectorAll('.btn-menu-item')) {
        const icon = text(it.querySelector('.btn-menu-item-icon'));
        if (icon === '' || DL_WORDS.test(text(it.querySelector('.btn-menu-item-text')))) return it;
      }
      return null;
    },
    busy() { return false; },
    async locate(job) { return this.findItems().find((x) => x.key === job.key) || null; },
  };

  // ------------------------------------------------------------------ Telegram Web A

  const A = {
    name: 'A',
    chatTitle() {
      return text(document.querySelector('.MiddleHeader .fullName')) || 'Telegram';
    },
    messageEl(id) {
      return document.getElementById('message-' + id) ||
        document.getElementById('album-media-message-' + id)?.closest('.Message') || null;
    },
    albumIds(msg) {
      const ids = [...msg.querySelectorAll('[id^="album-media-message-"]')].map((e) => e.id.replace('album-media-message-', ''));
      return ids.length ? ids : [msg.dataset.messageId];
    },
    findItems() {
      const items = [];
      const peer = location.hash;
      const list = document.querySelector('.MessageList:not(.hidden)');
      if (list) {
        for (const msg of list.querySelectorAll('.Message[data-message-id]')) {
          const id = msg.dataset.messageId;
          const prot = msg.classList.contains('is-protected');
          const time = text(msg.querySelector('.message-time'));
          const medias = [...msg.querySelectorAll('.media-inner')].filter((m) => durationOk(text(m.querySelector('.message-media-duration'))));
          if (medias.length) {
            const isAlbum = msg.classList.contains('is-album');
            const first = medias[0];
            items.push({
              key: keyOf(peer, id), host: first, prot, msg, kind: 'video',
              members: isAlbum ? this.albumIds(msg).map((m) => keyOf(peer, m)) : null,
              target: () => first,
              label: isAlbum ? `Album (${medias.length} video${medias.length > 1 ? 's' : ''})` : `Video ${text(first.querySelector('.message-media-duration'))}`,
              sub: time,
            });
          }
          for (const file of msg.querySelectorAll('.File')) {
            const ext = text(file.querySelector('.file-ext')).toLowerCase();
            if (!VIDEO_EXT.includes(ext)) continue;
            const titleEl = file.querySelector('.file-title');
            items.push({
              key: keyOf(peer, id), host: file, prot, msg, kind: 'file',
              target: () => file,
              label: titleEl?.getAttribute('title') || text(titleEl) || `video.${ext}`,
              sub: text(file.querySelector('.file-subtitle')),
            });
          }
        }
      }
      // Shared Media grid (profile panel). Telegram offers no download there, so these jobs
      // jump to the message first ("Show message") and download it from the chat.
      for (const cell of document.querySelectorAll('.Profile .Media[id^="shared-mediamessage-"]')) {
        const dur = text(cell.querySelector('.video-duration'));
        if (!durationOk(dur)) continue;
        const id = cell.id.replace('shared-mediamessage-', '');
        items.push({
          key: keyOf(peer, id), host: cell, prot: !!cell.querySelector('.protector'), grid: true, msgId: id, kind: 'video',
          target: () => cell,
          label: `Video ${dur}`, sub: 'Shared Media',
        });
      }
      return items;
    },
    menuOpen() {
      const m = document.querySelector('.MessageContextMenu, .shared-media-context-menu');
      return m && m.querySelector('.MenuItem') ? m : null;
    },
    downloadButton(menu) {
      if (!menu.classList.contains('MessageContextMenu') && !menu.closest('.MessageContextMenu')) return null;
      for (const it of menu.querySelectorAll('.MenuItem')) {
        if (it.querySelector('.icon-download') || DL_WORDS.test(text(it))) return it;
      }
      return null;
    },
    busy(item) {
      // Telegram is already transferring this media - clicking "Download" again would cancel it
      return !!item.msg?.querySelector('.message-transfer-progress');
    },
    async locate(job) {
      const items = this.findItems();
      const inChat = items.find((x) => x.key === job.key && !x.grid) ||
        items.find((x) => !x.grid && x.members && x.members.includes(job.key));
      if (inChat) return inChat;
      const cell = items.find((x) => x.key === job.key && x.grid);
      if (!cell) return null;
      if (cell.prot) return cell;
      // open "Show message" from the grid, then wait for the message in the chat
      if (this.menuOpen()) { escape(); await waitFor(() => !this.menuOpen(), 1000); }
      cell.host.scrollIntoView({ block: 'nearest' });
      rightClick(cell.host);
      const menu = await waitFor(() => document.querySelector('.shared-media-context-menu .MenuItem') && document.querySelector('.shared-media-context-menu'), 2500);
      if (!menu) return null;
      const show = menu.querySelector('.MenuItem');
      press(show);
      const msg = await waitFor(() => this.messageEl(cell.msgId), 10000, 150);
      if (!msg) return null;
      await sleep(600); // let the chat settle after jumping
      return this.findItems().find((x) => !x.grid && (x.key === job.key || (x.members && x.members.includes(job.key)))) || null;
    },
  };

  const app = () => (location.pathname.startsWith('/a') ? A : K);

  // ------------------------------------------------------------------ state

  const selected = new Map();   // key -> { label, sub, chat }
  let found = [];               // all items in the DOM (may contain the same key twice: chat + grid)
  const jobs = [];              // { key, label, sub, chat, status, dlId, started, error, members }
  let history = {};             // key -> time of finished download
  let parallel = 2;

  chrome.storage.local.get(['history', 'settings']).then((r) => {
    history = r.history || {};
    if (r.settings?.parallel) parallel = r.settings.parallel;
    decorate();
  });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== 'local') return;
    if (c.settings?.newValue?.parallel) { parallel = c.settings.newValue.parallel; pump(); }
    if (c.history) { history = c.history.newValue || {}; decorate(); }
  });
  bg('hello');

  function remember(keys) {
    const now = Date.now();
    for (const k of keys) history[k] = now;
    const all = Object.entries(history);
    if (all.length > HISTORY_MAX) {
      all.sort((a, b) => a[1] - b[1]);
      history = Object.fromEntries(all.slice(all.length - HISTORY_MAX));
    }
    chrome.storage.local.set({ history });
  }

  const uniq = () => {
    const m = new Map();
    for (const it of found) if (!m.has(it.key) || m.get(it.key).grid) m.set(it.key, it);
    return [...m.values()];
  };
  const jobOf = (k) => {
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].key === k) return jobs[i];
    return null;
  };
  const RUNNING = ['waiting', 'starting', 'started', 'downloading'];

  // ------------------------------------------------------------------ checkboxes in the page

  function stop(e) { e.stopPropagation(); e.stopImmediatePropagation(); }

  function toggle(k) {
    const cur = found.find((x) => x.key === k);
    if (!cur || cur.prot) return;
    if (selected.has(k)) selected.delete(k);
    else selected.set(k, { label: cur.label, sub: cur.sub, chat: app().chatTitle() });
    decorate();
  }

  function decorate() {
    found = app().findItems();
    const seen = new Set();
    for (const it of found) {
      let box = it.host.querySelector(':scope > .tgg-check');
      if (box && box.dataset.key !== it.key) { box.remove(); box = null; }
      if (!box) {
        box = document.createElement('div');
        box.className = 'tgg-check' + (it.kind === 'file' ? ' tgg-doc' : '') + (it.grid ? ' tgg-grid' : '');
        box.dataset.key = it.key;
        it.host.classList.add('tgg-host');
        for (const ev of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'dblclick', 'contextmenu']) {
          box.addEventListener(ev, (e) => { stop(e); if (ev === 'contextmenu') e.preventDefault(); }, true);
        }
        box.addEventListener('click', (e) => { stop(e); e.preventDefault(); toggle(box.dataset.key); }, true);
        it.host.appendChild(box);
      }
      seen.add(box);
      const job = jobOf(it.key);
      const queued = !!job && RUNNING.includes(job.status);
      const done = !queued && !!history[it.key];
      box.classList.toggle('on', selected.has(it.key));
      box.classList.toggle('locked', it.prot);
      box.classList.toggle('queued', queued);
      box.classList.toggle('done', done && !selected.has(it.key));
      box.title = it.prot ? 'Saving is disabled in this chat'
        : queued ? STATUS[job.status]
        : done ? 'Already downloaded - click to download again'
        : 'Select for download';
    }
    for (const box of document.querySelectorAll('.tgg-check')) if (!seen.has(box)) box.remove();
    updateBadge();
  }

  let lastBadge = '';
  function updateBadge() {
    const q = jobs.filter((j) => RUNNING.includes(j.status)).length;
    const text = q ? String(q) : (selected.size ? String(selected.size) : '');
    const color = q ? '#f0b44c' : '#9b6bff';
    if (text + color === lastBadge) return;
    lastBadge = text + color;
    bg('badge', { text, color });
  }

  // ------------------------------------------------------------------ queue

  const STATUS = {
    waiting: 'Waiting', starting: 'Starting…', started: 'Preparing in Telegram…', downloading: 'Downloading',
    done: 'Finished', failed: 'Failed', skipped: 'Skipped', canceled: 'Canceled',
  };
  const active = () => jobs.filter((j) => j.status === 'starting' || j.status === 'started' || j.status === 'downloading');

  function enqueueSelected() {
    for (const [key, info] of selected) {
      const j = jobOf(key);
      if (j && RUNNING.includes(j.status)) continue;
      jobs.push({ key, ...info, status: 'waiting', dlId: null, started: 0, error: '', members: null });
    }
    selected.clear();
    decorate();
    pump();
  }

  let pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (true) {
        for (const j of jobs) {
          if (j.status === 'started' && Date.now() - j.started > START_TIMEOUT) { j.status = 'failed'; j.error = 'No download started (timeout)'; }
        }
        const next = jobs.find((j) => j.status === 'waiting');
        if (!next || active().length >= parallel) break;
        await startJob(next);
        decorate();
        await sleep(400);
      }
    } finally {
      pumping = false;
    }
  }

  async function startJob(job) {
    const a = app();
    job.status = 'starting';

    if (a.menuOpen()) { escape(); await waitFor(() => !a.menuOpen(), 1000); }

    const item = await a.locate(job);
    if (!item) { job.status = 'failed'; job.error = 'Message not found - open the chat (or Shared Media) where it is and retry'; return; }
    if (item.prot) { job.status = 'skipped'; job.error = 'Saving is disabled in this chat'; return; }
    if (a.busy(item)) { job.status = 'skipped'; job.error = 'Telegram is already downloading this'; return; }

    // an album is downloaded as a whole: cover the other selected videos of the same album
    if (item.members && item.members.length > 1) {
      job.members = item.members;
      for (const other of jobs) {
        if (other !== job && other.status === 'waiting' && item.members.includes(other.key)) {
          other.status = 'done'; other.error = 'Included in album download';
        }
      }
    }

    const target = item.target();
    const r = target.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) {
      target.scrollIntoView({ block: 'center' });
      await sleep(350);
    }

    rightClick(target);
    const menu = await waitFor(() => a.menuOpen(), 2500);
    if (!menu) { job.status = 'failed'; job.error = 'Telegram menu did not open'; return; }
    const btn = await waitFor(() => a.downloadButton(menu) || (a.menuOpen() ? null : 'closed'), 1500);
    if (!btn || btn === 'closed') {
      escape();
      job.status = 'skipped';
      job.error = 'Telegram offers no download for this message';
      return;
    }
    job.started = Date.now();
    job.status = 'started';
    press(btn);
    await waitFor(() => !a.menuOpen(), 800);
    if (a.menuOpen()) escape();
  }

  // ------------------------------------------------------------------ messages (popup + background)

  function state() {
    const items = uniq().map((it) => {
      const j = jobOf(it.key);
      return {
        key: it.key, label: it.label, sub: it.sub, kind: it.kind, prot: it.prot, grid: !!it.grid,
        selected: selected.has(it.key), downloaded: !!history[it.key],
        queued: !!j && RUNNING.includes(j.status),
      };
    });
    return {
      app: app().name, chat: app().chatTitle(), items, parallel,
      jobs: jobs.map((j) => ({ key: j.key, label: j.label, sub: j.sub, chat: j.chat, status: j.status, statusText: STATUS[j.status], dlId: j.dlId, error: j.error })),
    };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    switch (msg.type) {
      case 'dlCreated': {
        const j = jobs.filter((x) => x.status === 'started' && x.dlId === null).sort((x, y) => x.started - y.started)[0];
        if (j) { j.dlId = msg.id; j.status = 'downloading'; decorate(); }
        return;
      }
      case 'dlDone': {
        const j = jobs.find((x) => x.dlId === msg.id);
        if (j) {
          j.status = msg.ok ? 'done' : (msg.error === 'USER_CANCELED' ? 'canceled' : 'failed');
          if (!msg.ok && msg.error !== 'USER_CANCELED') j.error = msg.error || 'Download interrupted';
          if (msg.ok) remember([j.key, ...(j.members || [])]);
          decorate();
          pump();
        }
        return;
      }
      case 'getState':
        decorate();
        sendResponse(state());
        return;
      case 'toggle':
        toggle(msg.key);
        sendResponse(state());
        return;
      case 'selectAll': {
        const t = app().chatTitle();
        for (const it of uniq()) {
          if (it.prot) continue;
          const j = jobOf(it.key);
          if (j && RUNNING.includes(j.status)) continue;
          if (history[it.key] && !msg.includeDownloaded) continue;
          selected.set(it.key, { label: it.label, sub: it.sub, chat: t });
        }
        decorate();
        sendResponse(state());
        return;
      }
      case 'clear':
        selected.clear();
        decorate();
        sendResponse(state());
        return;
      case 'start':
        enqueueSelected();
        sendResponse(state());
        return;
      case 'stopQueue':
        for (const j of jobs) if (j.status === 'waiting') j.status = 'canceled';
        decorate();
        sendResponse(state());
        return;
      case 'cleanFinished':
        for (let i = jobs.length - 1; i >= 0; i--) if (!RUNNING.includes(jobs[i].status)) jobs.splice(i, 1);
        decorate();
        sendResponse(state());
        return;
      case 'retry': {
        const j = jobOf(msg.key);
        if (j && !RUNNING.includes(j.status)) { j.status = 'waiting'; j.error = ''; j.dlId = null; pump(); }
        decorate();
        sendResponse(state());
        return;
      }
      case 'forget':
        delete history[msg.key];
        chrome.storage.local.set({ history });
        decorate();
        sendResponse(state());
        return;
      default:
    }
  });

  // ------------------------------------------------------------------ keep in sync with the chat

  setInterval(() => { pump(); decorate(); }, 1500);

  let moTimer = null;
  new MutationObserver((muts) => {
    if (muts.every((m) => m.target.classList && m.target.classList.contains('tgg-check'))) return;
    clearTimeout(moTimer);
    moTimer = setTimeout(decorate, 250);
  }).observe(document.body, { childList: true, subtree: true });

  decorate();
})();
