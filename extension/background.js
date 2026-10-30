// Telegram Grabber - service worker.
// Watches downloads that come from web.telegram.org, puts them into the chosen subfolder
// and reports progress to the Telegram tab. No access to any other website.

const TG = 'web.telegram.org';
let settings = { subfolder: 'Telegram', parallel: 2 };
let ready = chrome.storage.local.get('settings').then((r) => { settings = { ...settings, ...(r.settings || {}) }; });

chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.settings) settings = { ...settings, ...(c.settings.newValue || {}) };
});

function isTelegram(item) {
  const urls = [item.url, item.finalUrl, item.referrer].filter(Boolean);
  return urls.some((u) => {
    const s = u.startsWith('blob:') ? u.slice(5) : u;
    try { return new URL(s).hostname === TG; } catch { return false; }
  });
}

function cleanFolder(f) {
  return (f || '').replace(/[<>:"|?*]/g, '').replace(/^[\\/.\s]+|[\\/.\s]+$/g, '');
}

// --- Subfolder for Telegram downloads -----------------------------------------

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!isTelegram(item)) { suggest(); return; }
  ready.then(() => {
    const folder = cleanFolder(settings.subfolder);
    const name = (item.filename || 'telegram_video.mp4').split(/[\\/]/).pop();
    suggest(folder ? { filename: folder + '/' + name, conflictAction: 'uniquify' } : { filename: name, conflictAction: 'uniquify' });
  });
  return true;
});

// --- Progress reporting to the Telegram tabs ----------------------------------

// Telegram tabs are remembered in session storage, because the service worker sleeps between events.
let tabs = new Set();
const tabsReady = chrome.storage.session.get('tabs').then((r) => { tabs = new Set([...(r.tabs || []), ...tabs]); });
function addTab(id) {
  if (tabs.has(id)) return;
  tabs.add(id);
  chrome.storage.session.set({ tabs: [...tabs] });
}
async function broadcast(msg) {
  await tabsReady;
  for (const id of tabs) {
    chrome.tabs.sendMessage(id, msg).catch(() => { tabs.delete(id); chrome.storage.session.set({ tabs: [...tabs] }); });
  }
}

chrome.downloads.onCreated.addListener((item) => {
  if (isTelegram(item)) broadcast({ type: 'dlCreated', id: item.id, time: Date.now() });
});

chrome.downloads.onChanged.addListener((delta) => {
  const s = delta.state?.current;
  if (s !== 'complete' && s !== 'interrupted') return;
  chrome.downloads.search({ id: delta.id }).then(([item]) => {
    if (item && isTelegram(item)) {
      broadcast({ type: 'dlDone', id: delta.id, ok: s === 'complete', error: item.error || null });
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'background') return;
  (async () => {
    await ready;
    switch (msg.type) {
      case 'hello':
        if (sender.tab?.id !== undefined) addTab(sender.tab.id);
        return { settings };
      case 'badge':
        if (sender.tab?.id !== undefined) {
          addTab(sender.tab.id);
          chrome.action.setBadgeText({ tabId: sender.tab.id, text: msg.text || '' }).catch(() => {});
          chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: msg.color || '#9b6bff' }).catch(() => {});
        }
        return { ok: true };
      default:
        return { error: 'Unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});
