// ==UserScript==
// @name         Margonem – Dodatki (menedżer)
// @namespace    majcinai
// @version      0.5.0
// @description  Menedżer dodatków Margonem: włączanie i wyłączanie dodatków z okna Konfiguracji w grze. Dostęp sprawdzany przez oficjalne logowanie Margonem (bez kluczy); dodatki pobierane z prywatnego serwera i aktualizowane same.
// @author       majcinai
// @homepageURL  https://github.com/majcinai/margo-addons
// @updateURL    https://raw.githubusercontent.com/majcinai/margo-addons/main/margo-addons.user.js
// @downloadURL  https://raw.githubusercontent.com/majcinai/margo-addons/main/margo-addons.user.js
// @match        https://*.margonem.pl/*
// @match        https://margonem.pl/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      margo-dodatki.majcin94.workers.dev
// @connect      workers.dev
// @connect      public-api.margonem.pl
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (W.top !== W.self) return;
  if (W.MargoAddons && W.MargoAddons.__manager) return;

  const MANAGER_VERSION = '0.5.0';

  // ADRES SERWERA – ustaw po wdrożeniu (np. https://majcin-addons.twojanazwa.workers.dev)
  const SERVER_URL = 'https://margo-dodatki.majcin94.workers.dev';

  const IDLE_DELAY_MS = 1000;

  /* --------------------------- pamięć --------------------------- */
  const K = {
    state: 'mm.state',
    cache: 'mm.cache',
    userLabel: 'mm.userLabel',
    widget: 'mm.widgetPos',
    panel: 'mm.panelPos',
    data: (id, k) => 'a.' + id + '.' + k,
  };
  const load = (k, def) => { try { const v = GM_getValue(k); return v === undefined ? def : v; } catch (e) { return def; } };
  const save = (k, v) => { try { GM_setValue(k, v); } catch (e) {} };

  try { GM_deleteValue('mm.key'); } catch (e) {}   // stary klucz z wersji 0.2 nie jest już potrzebny
  const state = Object.assign({ enabled: {} }, load(K.state, {}));
  const saveState = () => save(K.state, state);
  let cache = load(K.cache, null) || { addons: [], at: 0 };
  let serverMsg = null;
  // Stan logowania: checking | ok | pending | rejected | revoked | error | offline
  const auth = { state: 'checking', uid: '', msg: '' };
  // Dodatki uruchamiają się WYŁĄCZNIE po udanej weryfikacji konta w tej sesji gry.
  let verified = false;

  const rt = {};
  const R = id => (rt[id] = rt[id] || { status: 'off' });

  /* --------------------------- sieć --------------------------- */
  function post(path, payload) {
    return new Promise((resolve, reject) => {
      if (!SERVER_URL || SERVER_URL.indexOf('__') === 0) return reject(new Error('Nie ustawiono adresu serwera'));
      GM_xmlhttpRequest({
        method: 'POST', url: SERVER_URL.replace(/\/$/, '') + path,
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify(payload), timeout: 15000,
        onload: r => { let d = {}; try { d = JSON.parse(r.responseText); } catch (e) {} resolve({ status: r.status, data: d, text: r.responseText }); },
        onerror: () => reject(new Error('błąd sieci')),
        ontimeout: () => reject(new Error('przekroczono czas')),
      });
    });
  }

  const heroInfo = () => {
    try { const d = W.Engine && W.Engine.hero && W.Engine.hero.d; if (d) return { account: String(d.account), nick: d.nick }; } catch (e) {}
    return { account: '', nick: '' };
  };
  const worldName = () => { try { return (W.Engine && W.Engine.worldConfig && W.Engine.worldConfig.getWorldName && W.Engine.worldConfig.getWorldName()) || ''; } catch (e) { return ''; } };

  function waitFor(test, ms = 20000, step = 300) {
    return new Promise(res => {
      const t0 = Date.now();
      (function loop() { let v; try { v = test(); } catch (e) {} if (v) return res(v); if (Date.now() - t0 > ms) return res(null); setTimeout(loop, step); })();
    });
  }

  const bareCode = c => String(c || '').replace(/^\s*\/\*[^\n]*?Margonem-Dodatki[\s\S]*?\*\/\s*/, '');

  const VALIDATE_URL = 'https://public-api.margonem.pl/account/validate';
  // Oficjalne potwierdzenie konta: POST token=<wyzwanie>, z ciasteczkami gracza.
  async function margonemProof(nonce) {
    const body = 'token=' + encodeURIComponent(nonce);
    const okProof = d => d && d.user_id != null && d.signatureBase64 && d.validatedString;
    try {
      const r = await W.fetch(VALIDATE_URL, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      if (r.ok) { const d = await r.json(); if (okProof(d)) return d; }
    } catch (e) {}
    return new Promise(res => {
      try {
        GM_xmlhttpRequest({
          method: 'POST', url: VALIDATE_URL, data: body, anonymous: false, timeout: 15000,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          onload: r => { let d = null; try { d = JSON.parse(r.responseText); } catch (e) {} res(okProof(d) ? d : null); },
          onerror: () => res(null), ontimeout: () => res(null),
        });
      } catch (e) { res(null); }
    });
  }

  let syncing = false;
  async function syncWithServer() {
    if (syncing) return; syncing = true;
    try { await doSync(); } finally { syncing = false; UI.refresh(); }
  }
  function setAuth(st, msg, uid) { if (st !== 'ok') verified = false; auth.state = st; auth.msg = msg || ''; if (uid != null && uid !== '') auth.uid = String(uid); serverMsg = (st === 'ok' || st === 'checking') ? null : (msg || null); UI.refresh(); Widget.update(); }
  function dropAccess() {
    // Brak dostępu: nie uruchamiaj już dodatków z pamięci przy kolejnym wejściu.
    for (const old of cache.addons) if (R(old.id).status === 'running') R(old.id).status = 'pendingOff';
    cache = { addons: [], at: Date.now() }; save(K.cache, cache);
  }
  async function doSync() {
    setAuth('checking');
    await waitFor(() => heroInfo().account);
    const hi = heroInfo();
    let ch;
    try { ch = await post('/api/challenge', {}); } catch (e) { return setAuth('offline', 'Brak połączenia z serwerem dodatków – dodatki uruchomią się po potwierdzeniu dostępu.'); }
    if (ch.status !== 200 || !ch.data.nonce) return setAuth('offline', 'Serwer dodatków nie odpowiada (' + ch.status + ').');
    const proof = await margonemProof(ch.data.nonce);
    if (!proof) return setAuth('error', 'Nie udało się potwierdzić konta w Margonem. Upewnij się, że jesteś zalogowany na margonem.pl, i odśwież grę.');
    auth.uid = String(proof.user_id);
    let res;
    try { res = await post('/api/login', { nonce: ch.data.nonce, proof, nick: hi.nick, world: worldName(), managerVersion: MANAGER_VERSION }); }
    catch (e) { return setAuth('offline', 'Brak połączenia z serwerem dodatków – dodatki uruchomią się po potwierdzeniu dostępu.'); }
    const d = res.data || {};
    if (res.status === 403 && ['pending', 'rejected', 'revoked'].includes(d.error)) { dropAccess(); return setAuth(d.error, d.message, d.uid); }
    if (res.status !== 200 || !d.ok) return setAuth('error', d.message || ('Błąd serwera (' + res.status + ')'));
    save(K.userLabel, (d.player && d.player.label) || '');
    // Serwer zwraca tylko opis i skrót (hash) kodu; kod pobieramy pojedynczo, tylko gdy się zmienił.
    const incoming = [];
    for (const m of d.addons || []) {
      const old = cache.addons.find(x => x.id === m.id);
      if (m.legacy) { if (old) incoming.push(old); continue; }          // serwer jeszcze przenosi ten dodatek – zostaw swoją kopię
      if (old && old.hash && old.hash === m.hash && old.code) { incoming.push(Object.assign({}, old, m, { code: old.code })); continue; }
      let code = null;
      try { const r = await post('/api/code', { ticket: d.ticket, id: m.id }); if (r.status === 200 && r.text) code = r.text; } catch (e) {}
      if (code == null) { if (old) incoming.push(old); continue; }       // nie udało się pobrać – użyj poprzedniej wersji
      incoming.push(Object.assign({}, m, { code }));
      if (old && R(m.id).status === 'running' && bareCode(old.code) !== bareCode(code)) R(m.id).updateReady = m.version || '?';
    }
    for (const old of cache.addons) if (!incoming.find(a => a.id === old.id) && R(old.id).status === 'running') R(old.id).status = 'pendingOff';
    cache = { addons: incoming, at: Date.now() };
    save(K.cache, cache);
    verified = true;
    setAuth('ok', '', d.uid);
    for (const a of incoming) if (state.enabled[a.id] && R(a.id).status === 'off') startAddon(a);
  }

  /* --------------------------- nagłówek --------------------------- */
  function parseMeta(code) {
    const meta = { name: '', version: '', match: [], include: [], exclude: [], grant: [], runAt: 'document-idle' };
    const block = code.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
    if (!block) return meta;
    for (const line of block[1].split('\n')) {
      const m = line.match(/^\s*\/\/\s*@(\S+)\s*(.*?)\s*$/); if (!m) continue;
      const [, key, val] = m;
      if (['match', 'include', 'exclude', 'grant'].includes(key)) meta[key].push(val);
      else if (key === 'run-at') meta.runAt = val;
      else if ((key === 'name' || key === 'version') && !meta[key]) meta[key] = val;
    }
    return meta;
  }

  /* --------------------------- uruchamianie --------------------------- */
  const GM_get = GM_getValue, GM_set = GM_setValue, GM_del = GM_deleteValue, GM_list = GM_listValues;
  function makeGM(addon, meta) {
    const pre = K.data(addon.id, '');
    const g = {
      GM_getValue: (k, d) => { const v = GM_get(pre + k); return v === undefined ? d : v; },
      GM_setValue: (k, v) => GM_set(pre + k, v),
      GM_deleteValue: k => GM_del(pre + k),
      GM_listValues: () => GM_list().filter(k => k.startsWith(pre)).map(k => k.slice(pre.length)),
      GM_addStyle: css => { const s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); return s; },
      GM_xmlhttpRequest: GM_xmlhttpRequest,
      GM_registerMenuCommand: (n, f) => { try { GM_registerMenuCommand((addon.name || addon.id) + ': ' + n, f); } catch (e) {} },
      GM_info: { script: { name: addon.name, version: meta.version }, scriptHandler: 'Margonem – Dodatki', version: MANAGER_VERSION },
      unsafeWindow: W,
    };
    g.GM = {
      getValue: async (k, d) => g.GM_getValue(k, d), setValue: async (k, v) => g.GM_setValue(k, v),
      deleteValue: async k => g.GM_deleteValue(k), listValues: async () => g.GM_listValues(),
      addStyle: g.GM_addStyle, xmlHttpRequest: g.GM_xmlhttpRequest, info: g.GM_info, registerMenuCommand: g.GM_registerMenuCommand,
    };
    return g;
  }

  function execute(addon) {
    const r = R(addon.id);
    const meta = parseMeta(addon.code);
    const grants = meta.grant.filter(g => g && g !== 'none');
    const src = addon.code + '\n//# sourceURL=margo-addon-' + addon.id + '.user.js';
    try { new Function(src); } catch (e) { return markError(addon.id, e); }
    r.status = 'running'; r.runningVersion = addon.version || meta.version;
    try {
      if (grants.length === 0) {
        const s = document.createElement('script');
        s.textContent = '(function(){try{\n' + src + '\n}catch(e){window.MargoAddons&&window.MargoAddons._error(' + JSON.stringify(addon.id) + ',e)}})();';
        (document.head || document.documentElement).appendChild(s); s.remove();
      } else {
        const gm = makeGM(addon, meta), names = Object.keys(gm);
        (new Function(...names, src)).apply(W, names.map(n => gm[n]));
      }
    } catch (e) { return markError(addon.id, e); }
    UI.refresh();
  }

  function whenReady(runAt) {
    return new Promise(res => {
      if (runAt === 'document-start') return res();
      const go = () => runAt === 'document-end' ? res() : setTimeout(res, IDLE_DELAY_MS);
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true }); else go();
    });
  }

  async function startAddon(addon) {
    if (!verified) return;                       // bez potwierdzonego dostępu nic nie startuje
    const r = R(addon.id);
    if (r.status === 'running' || r.status === 'loading') return;
    r.error = null;
    const meta = parseMeta(addon.code);
    await whenReady(meta.runAt);
    if (!state.enabled[addon.id]) { r.status = 'off'; return UI.refresh(); }
    execute(addon);
  }

  function stopAddon(addon) {
    const r = R(addon.id);
    if (r.status !== 'running') { r.status = 'off'; return UI.refresh(); }
    if (typeof r.stop === 'function') { try { r.stop(); r.status = 'off'; r.stop = null; } catch (e) { r.status = 'pendingOff'; } }
    else r.status = 'pendingOff';
    UI.refresh();
  }

  function setEnabled(id, on) {
    if (!verified) { UI.flash('Najpierw musi zostać potwierdzony dostęp.'); UI.refresh(); return; }
    const addon = cache.addons.find(a => a.id === id); if (!addon) return;
    state.enabled[id] = on; saveState();
    if (on) { const r = R(id); if (r.status === 'pendingOff') { r.status = 'running'; UI.refresh(); return; } startAddon(addon); }
    else stopAddon(addon);
  }

  function markError(id, e) { const r = R(id); r.status = 'error'; r.error = (e && e.message) || String(e); console.error('[Dodatki] ' + id + ':', e); UI.refresh(); }

  /* --------------------------- API dla dodatków --------------------------- */
  W.MargoAddons = {
    __manager: true, version: MANAGER_VERSION,
    register(id, opts) { const r = R(id); if (opts && typeof opts.stop === 'function') r.stop = opts.stop; },
    isEnabled: id => !!state.enabled[id],
    open: () => UI.open(),
    _error: (id, e) => markError(id, e),
  };

  /* --------------------------- interfejs --------------------------- */
  // Ikony w stylu lucide (rysowane w skrypcie – nic nie jest pobierane z sieci).
  const SVG = {
    puzzle: '<path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    rotate: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    swords: '<polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" x2="19" y1="19" y2="13"/><line x1="16" x2="20" y1="16" y2="20"/><line x1="19" x2="21" y1="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5" x2="9" y1="14" y2="18"/><line x1="7" x2="4" y1="17" y2="20"/><line x1="3" x2="5" y1="19" y2="21"/>',
    layout: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
    map: '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>',
    dots: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    timer: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    trending: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  };
  const ico = (n, s) => { s = s || 16; return '<svg class="mjd-i" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (SVG[n] || SVG.puzzle) + '</svg>'; };

  const norm = t => String(t || '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '');

  /* --- kategorie: pole `category` z serwera, a gdy go brak – zgadywanie po słowach --- */
  const CATS = [
    { id: 'walka', label: 'Walka', icon: 'swords', kw: ['walk', 'bitw', 'boss', 'hero', 'tytan', 'kolos', 'elit', 'potwor', 'mob', 'exp', 'dosw', 'leczen', 'mikstur', 'obraz', 'pvp', 'atak', 'lup'] },
    { id: 'interfejs', label: 'Interfejs', icon: 'layout', kw: ['interfejs', 'hud', 'okno', 'okien', 'wyglad', 'motyw', 'pasek', 'paska', 'ekwip', 'plecak', 'przycisk', 'tooltip', 'skrot', 'widget', 'licznik'] },
    { id: 'czat', label: 'Czat', icon: 'message', kw: ['czat', 'chat', 'wiadomo', 'szept', 'priv', 'rozmow'] },
    { id: 'handel', label: 'Handel', icon: 'coins', kw: ['handel', 'handl', 'aukc', 'cena', 'ceny', 'sklep', 'zlot', 'targ', 'kupi', 'kupn', 'sprzed'] },
    { id: 'mapa', label: 'Mapa', icon: 'map', kw: ['mapa', 'mapy', 'mape', 'minimap', 'teleport', 'lokac', 'tras', 'koordyn', 'przejsc', 'nawig'] },
  ];
  const OTHER = { id: 'inne', label: 'Inne', icon: 'dots' };
  const GUESS_ORDER = ['czat', 'handel', 'mapa', 'walka', 'interfejs'];   // od najbardziej szczegółowej
  function catOf(a) {
    if (a.category) {
      const c = norm(a.category).trim();
      const known = CATS.concat(OTHER).find(x => x.id === c || norm(x.label) === c);
      if (known) return known;
      const label = String(a.category).trim();
      return { id: 'x-' + c, label: label.charAt(0).toUpperCase() + label.slice(1), icon: 'tag', custom: true };
    }
    const hay = norm((a.name || a.id) + ' ' + (a.description || ''));
    for (const id of GUESS_ORDER) { const c = CATS.find(x => x.id === id); if (c.kw.some(k => hay.includes(k))) return c; }
    return OTHER;
  }

  const CSS = `
  .mjd-addons-btn.button{position:absolute!important;left:50%;top:3px;transform:translateX(-50%);width:84px;min-width:0!important;margin:0!important}

  #mjd-panel{--bg:#12141a;--sf:#191c24;--el:#20242e;--bd:rgba(255,255,255,.07);--bd2:rgba(255,255,255,.12);--t1:#e8eaf0;--t2:#9aa1b2;--t3:#6b7285;
    --gold:#f2c94c;--ok:#3ecf8e;--warn:#f5a524;--bad:#f0556a;--info:#5ab0ff;
    position:fixed;z-index:2000;left:0;top:0;width:min(800px,calc(100vw - 16px));height:min(620px,calc(100vh - 16px));
    display:none;flex-direction:column;overflow:hidden;background:var(--bg);color:var(--t1);border:1px solid var(--bd);border-radius:14px;
    box-shadow:0 20px 50px rgba(0,0,0,.55);font:13px/1.4 "Segoe UI",Inter,system-ui,-apple-system,sans-serif;letter-spacing:0;text-align:left;
    opacity:0;transform:scale(.98);transition:opacity .15s ease,transform .15s ease}
  #mjd-panel.show{display:flex}
  #mjd-panel.in{opacity:1;transform:none}
  #mjd-panel *,#mjd-panel *::before,#mjd-panel *::after{box-sizing:border-box}
  #mjd-panel button{-webkit-appearance:none;appearance:none;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;line-height:1;cursor:pointer;text-shadow:none}
  #mjd-panel .mjd-i{display:block;flex:none}
  #mjd-panel b{font-weight:600}

  #mjd-panel .mjd-h{display:flex;align-items:center;gap:12px;padding:12px 12px 12px 16px;border-bottom:1px solid var(--bd);cursor:grab;user-select:none;flex:none}
  #mjd-panel.dragging .mjd-h{cursor:grabbing}
  #mjd-panel .mjd-mark{width:32px;height:32px;border-radius:8px;background:var(--sf);border:1px solid var(--bd);display:flex;align-items:center;justify-content:center;color:var(--gold);flex:none}
  #mjd-panel .mjd-ht{flex:1;min-width:0}
  #mjd-panel .mjd-title{font-weight:600;font-size:14px;line-height:1.2;color:var(--t1)}
  #mjd-panel .mjd-sub{font-size:11px;color:var(--t3);margin-top:2px}
  #mjd-panel .mjd-sub b{color:var(--gold)}
  #mjd-panel .mjd-ib{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:8px;color:var(--t3);transition:background .15s,color .15s;flex:none}
  #mjd-panel .mjd-ib:hover{background:var(--sf);color:var(--t1)}

  #mjd-panel .mjd-auth{display:flex;align-items:center;gap:8px;padding:5px 8px 5px 16px;background:var(--sf);border-bottom:1px solid var(--bd);font-size:12px;color:var(--t2);flex:none}
  #mjd-panel .mjd-auth .mjd-ib{width:26px;height:26px}
  #mjd-panel .mjd-auth .mjd-ib:hover{background:var(--el)}
  #mjd-panel .mjd-dot{width:8px;height:8px;border-radius:50%;background:var(--warn);flex:none}
  #mjd-panel .mjd-a-ok .mjd-dot{background:var(--ok);box-shadow:0 0 0 3px rgba(62,207,142,.15)}
  #mjd-panel .mjd-a-bad .mjd-dot{background:var(--bad);box-shadow:0 0 0 3px rgba(240,85,106,.15)}
  #mjd-panel .mjd-a-wait .mjd-dot{animation:mjd-pulse 1.4s ease-in-out infinite}
  #mjd-panel .mjd-atext{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #mjd-panel .mjd-uid{color:var(--t3)}
  #mjd-panel.checking .mjd-retry .mjd-i,#mjd-panel .mjd-spin .mjd-i{animation:mjd-spin 1s linear infinite}

  #mjd-panel .mjd-tools{padding:12px 16px;border-bottom:1px solid var(--bd);flex:none}
  #mjd-panel .mjd-search{position:relative;display:flex;align-items:center;margin:0}
  #mjd-panel .mjd-search>.mjd-i{position:absolute;left:12px;color:var(--t3);pointer-events:none}
  #mjd-panel .mjd-q{width:100%;height:36px;margin:0;padding:0 72px 0 36px;background:var(--sf);color:var(--t1);border:1px solid var(--bd);border-radius:10px;
    font:inherit;font-size:13px;outline:none;box-shadow:none;transition:border-color .15s,box-shadow .15s}
  #mjd-panel .mjd-q::placeholder{color:var(--t3);opacity:1}
  #mjd-panel .mjd-q:focus{border-color:rgba(242,201,76,.5);box-shadow:0 0 0 3px rgba(242,201,76,.12)}
  #mjd-panel .mjd-qx{position:absolute;right:44px;width:22px;height:22px;border-radius:6px;display:none;align-items:center;justify-content:center;color:var(--t3)}
  #mjd-panel .mjd-qx:hover{color:var(--t1);background:var(--el)}
  #mjd-panel .mjd-search.has-q .mjd-qx{display:flex}
  #mjd-panel .mjd-qn{position:absolute;right:12px;font-size:11px;color:var(--t3);pointer-events:none}

  #mjd-panel .mjd-body{flex:1;min-height:0;display:flex}
  #mjd-panel .mjd-side{width:168px;flex:none;border-right:1px solid var(--bd);padding:8px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
  #mjd-panel .mjd-cat{display:flex;align-items:center;gap:9px;width:100%;height:32px;padding:0 10px;border-radius:8px;color:var(--t2);font-size:12.5px;text-align:left;transition:background .15s,color .15s;flex:none}
  #mjd-panel .mjd-cat:hover{background:var(--sf);color:var(--t1)}
  #mjd-panel .mjd-cat.act{background:var(--el);color:var(--gold);font-weight:600}
  #mjd-panel .mjd-cl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #mjd-panel .mjd-cn{font-size:11px;color:var(--t3);font-weight:400}
  #mjd-panel .mjd-cat.act .mjd-cn{color:var(--gold);opacity:.75}
  #mjd-panel .mjd-cat.zero:not(.act){opacity:.45}
  #mjd-panel .mjd-sep{height:1px;background:var(--bd);margin:6px 8px;flex:none}

  #mjd-panel .mjd-list{flex:1;min-width:0;overflow-y:auto;overscroll-behavior:contain}
  #mjd-panel .mjd-row{position:relative;display:flex;align-items:center;gap:12px;min-height:46px;padding:6px 12px 6px 16px;border-bottom:1px solid var(--bd);transition:background .15s}
  #mjd-panel .mjd-row:hover{background:var(--sf)}
  #mjd-panel .mjd-row.on::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--gold)}
  #mjd-panel .mjd-tile{width:28px;height:28px;border-radius:8px;background:var(--sf);border:1px solid var(--bd);color:var(--t3);display:flex;align-items:center;justify-content:center;flex:none;transition:color .15s,border-color .15s,background .15s}
  #mjd-panel .mjd-row.on .mjd-tile{color:var(--gold);border-color:rgba(242,201,76,.25);background:rgba(242,201,76,.06)}
  #mjd-panel .mjd-main{flex:1;min-width:0;display:flex;align-items:center;gap:8px}
  #mjd-panel .mjd-name{font-weight:600;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%;flex:none}
  #mjd-panel .mjd-ver{font-size:11px;line-height:16px;color:var(--t3);padding:0 7px;border:1px solid var(--bd);border-radius:999px;background:var(--sf);white-space:nowrap;flex:none}
  #mjd-panel .mjd-desc{flex:1;min-width:0;color:var(--t3);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #mjd-panel .mjd-link{display:flex;color:var(--t3);opacity:0;transition:opacity .15s,color .15s;text-decoration:none;flex:none}
  #mjd-panel .mjd-row:hover .mjd-link,#mjd-panel .mjd-link:focus-visible{opacity:1}
  #mjd-panel .mjd-link:hover{color:var(--t1)}
  #mjd-panel .mjd-st{display:flex;align-items:center;justify-content:flex-end;gap:6px;width:150px;flex:none;font-size:11px;white-space:nowrap}
  #mjd-panel .mjd-st span{overflow:hidden;text-overflow:ellipsis}
  #mjd-panel .mjd-st i{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
  #mjd-panel .mjd-s-running{color:var(--ok)}
  #mjd-panel .mjd-s-loading,#mjd-panel .mjd-s-pending{color:var(--warn)}
  #mjd-panel .mjd-s-error{color:var(--bad)}
  #mjd-panel .mjd-s-update{color:var(--info)}
  #mjd-panel .mjd-sw{position:relative;width:34px;height:20px;border-radius:999px;background:var(--el);border:1px solid var(--bd2);flex:none;transition:background .15s,border-color .15s}
  #mjd-panel .mjd-sw i{position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:var(--t3);transition:transform .15s ease,background .15s}
  #mjd-panel .mjd-sw[aria-checked="true"]{background:rgba(242,201,76,.22);border-color:rgba(242,201,76,.45)}
  #mjd-panel .mjd-sw[aria-checked="true"] i{transform:translateX(14px);background:var(--gold)}
  #mjd-panel .mjd-sw:hover{border-color:rgba(242,201,76,.6)}
  #mjd-panel .mjd-sw:focus-visible,#mjd-panel .mjd-cat:focus-visible,#mjd-panel .mjd-ib:focus-visible,#mjd-panel .mjd-btn:focus-visible{outline:2px solid rgba(242,201,76,.6);outline-offset:2px}

  #mjd-panel .mjd-state{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:8px;padding:48px 24px;min-height:100%;color:var(--t3)}
  #mjd-panel .mjd-state>.mjd-i{margin-bottom:4px}
  #mjd-panel .mjd-state.bad>.mjd-i{color:var(--bad)}
  #mjd-panel .mjd-state.wait>.mjd-i{color:var(--warn)}
  #mjd-panel .mjd-st-t{color:var(--t1);font-weight:600;font-size:14px}
  #mjd-panel .mjd-st-d{max-width:380px;font-size:12px;line-height:1.55;color:var(--t2)}
  #mjd-panel .mjd-st-d b{color:var(--gold)}
  #mjd-panel .mjd-st-a{display:flex;gap:8px;margin-top:8px}
  #mjd-panel .mjd-btn{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 14px;border-radius:10px;background:var(--gold);color:#12141a;font-weight:600;font-size:12.5px;transition:filter .15s,background .15s;flex:none}
  #mjd-panel .mjd-btn:hover{filter:brightness(1.08)}
  #mjd-panel .mjd-btn.ghost{background:var(--sf);color:var(--t1);border:1px solid var(--bd2)}
  #mjd-panel .mjd-btn.ghost:hover{background:var(--el);filter:none}

  #mjd-panel .mjd-reload{display:none;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px 10px 16px;background:var(--sf);border-top:1px solid var(--bd);box-shadow:0 -4px 10px rgba(0,0,0,.2);flex:none;font-size:12px;color:var(--t2)}
  #mjd-panel .mjd-reload>span{display:flex;align-items:center;gap:8px;min-width:0}
  #mjd-panel .mjd-reload>span .mjd-i{color:var(--info)}
  #mjd-panel.need-reload .mjd-reload{display:flex}
  #mjd-panel .mjd-toast{position:absolute;left:50%;bottom:16px;transform:translate(-50%,8px);padding:8px 12px;border-radius:10px;background:var(--el);border:1px solid var(--bd2);color:var(--t1);font-size:12px;
    box-shadow:0 8px 24px rgba(0,0,0,.4);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;white-space:nowrap;z-index:2}
  #mjd-panel .mjd-toast.show{opacity:1;transform:translate(-50%,0)}
  #mjd-panel.need-reload .mjd-toast{bottom:68px}
  #mjd-panel.locked .mjd-tools,#mjd-panel.locked .mjd-side{display:none}

  #mjd-panel .mjd-list,#mjd-panel .mjd-side{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.12) transparent}
  #mjd-panel .mjd-list::-webkit-scrollbar,#mjd-panel .mjd-side::-webkit-scrollbar{width:6px}
  #mjd-panel .mjd-list::-webkit-scrollbar-track,#mjd-panel .mjd-side::-webkit-scrollbar-track{background:transparent}
  #mjd-panel .mjd-list::-webkit-scrollbar-thumb,#mjd-panel .mjd-side::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:999px}
  #mjd-panel .mjd-list::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.2)}
  @keyframes mjd-spin{to{transform:rotate(360deg)}}
  @keyframes mjd-pulse{50%{opacity:.35}}
  @media (max-width:700px){
    #mjd-panel .mjd-side{width:52px;padding:8px 6px}
    #mjd-panel .mjd-cl,#mjd-panel .mjd-cn{display:none}
    #mjd-panel .mjd-cat{justify-content:center;padding:0}
    #mjd-panel .mjd-sep{margin:6px 4px}
    #mjd-panel .mjd-desc{display:none}
    #mjd-panel .mjd-st{width:auto;max-width:96px}
  }
  @media (prefers-reduced-motion:reduce){#mjd-panel,#mjd-panel *{transition:none!important;animation:none!important}}

  .mjd-widget{position:fixed;z-index:450;left:0;top:0;display:flex;align-items:center;gap:6px;height:26px;padding:0 11px 0 9px;border-radius:999px;
    background:rgba(25,28,36,.92);border:1px solid rgba(255,255,255,.1);box-shadow:0 4px 14px rgba(0,0,0,.45);
    color:#e8eaf0;font:600 12px/1 "Segoe UI",Inter,system-ui,sans-serif;letter-spacing:.2px;cursor:pointer;user-select:none;touch-action:none;white-space:nowrap;
    opacity:.92;transition:opacity .15s,background .15s,border-color .15s}
  .mjd-widget:hover{opacity:1;background:#20242e;border-color:rgba(242,201,76,.35)}
  .mjd-widget.dragging{cursor:grabbing;opacity:1}
  .mjd-widget .mjd-w-ai{color:#f2c94c}
  .mjd-widget .mjd-w-dot{width:7px;height:7px;border-radius:50%;background:#f5a524;flex:none}
  .mjd-widget.w-ok .mjd-w-dot{background:#3ecf8e;box-shadow:0 0 0 3px rgba(62,207,142,.18)}
  .mjd-widget.w-bad .mjd-w-dot{background:#f0556a;box-shadow:0 0 0 3px rgba(240,85,106,.18)}
  `;
  function addCss() { const s = document.createElement('style'); s.id = 'mjd-addons-css'; s.textContent = CSS; (document.head || document.documentElement).appendChild(s); }

  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const gmeBtn = (label, cls) => { const b = el('div', 'button green small ' + (cls || '')); b.innerHTML = '<div class="background"></div><div class="label">' + esc(label) + '</div>'; return b; };
  const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? u : '';

  const AUTH_TXT = {
    checking: { c: 'wait', t: 'Sprawdzam konto Margonem…' },
    ok: { c: 'ok', t: 'Dostęp potwierdzony' },
    pending: { c: 'wait', t: 'Czeka na akceptację administratora' },
    rejected: { c: 'bad', t: 'Dostęp nieprzyznany' },
    revoked: { c: 'bad', t: 'Dostęp cofnięty' },
    offline: { c: 'wait', t: 'Serwer niedostępny' },
    error: { c: 'bad', t: 'Nie udało się potwierdzić konta' },
  };

  function rowStatus(r) {
    if (r.status === 'error') return { c: 'error', t: r.error ? 'Błąd: ' + r.error : 'Błąd' };
    if (r.status === 'pendingOff') return { c: 'pending', t: 'Wyłączy się po odświeżeniu', tip: 'Dodatek wyłączy się po odświeżeniu gry' };
    if (r.updateReady) return { c: 'update', t: 'Nowa wersja v' + r.updateReady, tip: 'Nowa wersja v' + r.updateReady + ' zadziała po odświeżeniu gry' };
    if (r.status === 'loading') return { c: 'loading', t: 'Uruchamianie…' };
    if (r.status === 'running') return { c: 'running', t: 'Działa' };
    return null;
  }

  const UI = {
    root: null, list: null, side: null, q: null, _t: null, query: '', cat: 'all', visible: false, pos: null,
    build() {
      const root = this.root = el('div', '');
      root.id = 'mjd-panel'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Dodatki');
      root.innerHTML =
        '<header class="mjd-h">' +
          '<div class="mjd-mark">' + ico('puzzle', 18) + '</div>' +
          '<div class="mjd-ht"><div class="mjd-title">Dodatki</div><div class="mjd-sub">m<b>(AI)</b>cin · v' + esc(MANAGER_VERSION) + '</div></div>' +
          '<button type="button" class="mjd-ib mjd-close" title="Zamknij (Esc)" aria-label="Zamknij">' + ico('x', 18) + '</button>' +
        '</header>' +
        '<div class="mjd-auth"><span class="mjd-dot"></span><span class="mjd-atext"></span>' +
          '<button type="button" class="mjd-ib mjd-retry" title="Sprawdź dostęp ponownie" aria-label="Sprawdź dostęp ponownie">' + ico('rotate', 14) + '</button></div>' +
        '<div class="mjd-tools"><label class="mjd-search">' + ico('search', 15) +
          '<input type="text" class="mjd-q" placeholder="Szukaj dodatku…" spellcheck="false" autocomplete="off">' +
          '<button type="button" class="mjd-qx" title="Wyczyść (Esc)" aria-label="Wyczyść">' + ico('x', 14) + '</button><span class="mjd-qn"></span></label></div>' +
        '<div class="mjd-body"><nav class="mjd-side" aria-label="Kategorie"></nav><div class="mjd-list"></div></div>' +
        '<div class="mjd-toast" role="status"></div>' +
        '<footer class="mjd-reload"><span>' + ico('info', 15) + '<span>Część zmian zadziała po odświeżeniu gry</span></span>' +
          '<button type="button" class="mjd-btn mjd-do-reload">' + ico('refresh', 14) + 'Odśwież grę</button></footer>';
      document.body.appendChild(root);
      this.list = root.querySelector('.mjd-list'); this.side = root.querySelector('.mjd-side');
      this.q = root.querySelector('.mjd-q'); this.search = root.querySelector('.mjd-search'); this.qn = root.querySelector('.mjd-qn');
      this.authBar = root.querySelector('.mjd-auth'); this.authText = root.querySelector('.mjd-atext'); this.toast = root.querySelector('.mjd-toast');

      // Klawisze i kliknięcia w panelu nie mogą trafiać do gry (skróty, ruch postaci).
      ['keydown', 'keyup', 'keypress'].forEach(t => root.addEventListener(t, ev => {
        ev.stopPropagation();
        if (t === 'keydown' && ev.key === 'Escape') { ev.preventDefault(); if (this.q.value) this.setQuery(''); else this.hide(); }
      }));
      ['mousedown', 'pointerdown', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart'].forEach(t => root.addEventListener(t, ev => ev.stopPropagation(), { passive: true }));

      root.querySelector('.mjd-close').addEventListener('click', () => this.hide());
      root.querySelector('.mjd-retry').addEventListener('click', () => this.retry());
      root.querySelector('.mjd-do-reload').addEventListener('click', () => location.reload());
      this.q.addEventListener('input', () => { this.query = this.q.value; this.render(); });
      root.querySelector('.mjd-qx').addEventListener('click', ev => { ev.preventDefault(); this.setQuery(''); this.q.focus(); });
      this.side.addEventListener('click', ev => {
        const b = ev.target.closest('.mjd-cat'); if (!b) return;
        this.cat = b.dataset.cat; this.render(); this.list.scrollTop = 0;
      });
      this.list.addEventListener('click', ev => {
        const sw = ev.target.closest('.mjd-sw');
        if (sw) { const id = sw.closest('.mjd-row').dataset.id; setEnabled(id, !state.enabled[id]); return; }
        const act = ev.target.closest('[data-act]'); if (!act) return;
        if (act.dataset.act === 'retry') this.retry();
        else if (act.dataset.act === 'all') { this.cat = 'all'; this.render(); }
        else if (act.dataset.act === 'clear') { this.setQuery(''); this.q.focus(); }
        else if (act.dataset.act === 'copy') this.copyId();
      });

      // Przeciąganie za nagłówek; dwuklik na nagłówku = wyśrodkuj.
      const hd = root.querySelector('.mjd-h'); let d = null;
      hd.addEventListener('pointerdown', ev => {
        if (ev.button !== 0 || ev.target.closest('button')) return;
        ev.preventDefault(); d = { mx: ev.clientX, my: ev.clientY, x: this.pos.x, y: this.pos.y };
        root.classList.add('dragging'); try { hd.setPointerCapture(ev.pointerId); } catch (e) {}
      });
      hd.addEventListener('pointermove', ev => { if (d) this.place({ x: d.x + ev.clientX - d.mx, y: d.y + ev.clientY - d.my }); });
      const end = ev => { if (!d) return; d = null; root.classList.remove('dragging'); save(K.panel, this.pos); try { hd.releasePointerCapture(ev.pointerId); } catch (e) {} };
      hd.addEventListener('pointerup', end); hd.addEventListener('pointercancel', end);
      hd.addEventListener('dblclick', ev => { if (!ev.target.closest('button')) this.place(null, true); });
      let rt = null;
      addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (this.visible) this.place(this.pos); }, 120); });
    },
    place(pos, persist) {
      const r = this.root, w = r.offsetWidth, h = r.offsetHeight;
      if (!pos) pos = { x: (innerWidth - w) / 2, y: (innerHeight - h) / 2 };
      const x = Math.max(8, Math.min(innerWidth - w - 8, pos.x)), y = Math.max(8, Math.min(innerHeight - h - 8, pos.y));
      this.pos = { x: Math.round(x), y: Math.round(y) };
      r.style.left = this.pos.x + 'px'; r.style.top = this.pos.y + 'px';
      if (persist) save(K.panel, this.pos);
    },
    open() {
      if (!document.body) return;
      if (!this.root) this.build();
      const r = this.root;
      if (!this.visible) {
        this.visible = true;
        r.classList.add('show'); this.place(this.pos || load(K.panel, null));
        void r.offsetWidth; r.classList.add('in');
      }
      this.render();
      if (auth.state === 'ok') setTimeout(() => { try { this.q.focus({ preventScroll: true }); this.q.select(); } catch (e) {} }, 40);
    },
    hide() {
      if (!this.root || !this.visible) return;
      this.visible = false;
      const r = this.root; r.classList.remove('in');
      try { if (r.contains(document.activeElement)) document.activeElement.blur(); } catch (e) {}
      setTimeout(() => { if (!this.visible) r.classList.remove('show'); }, 160);
    },
    toggle() { if (this.visible) this.hide(); else this.open(); },
    retry() { this.flash('Sprawdzam dostęp…'); syncWithServer(); },
    setQuery(v) { this.q.value = v; this.query = v; this.render(); },
    copyId() {
      const done = () => this.flash('Skopiowano ID konta');
      try { W.navigator.clipboard.writeText(auth.uid).then(done, () => this.flash('Nie udało się skopiować – ID: ' + auth.uid)); }
      catch (e) { this.flash('ID konta: ' + auth.uid); }
    },
    refresh() { if (!this.root || !this.visible) return; clearTimeout(this._t); this._t = setTimeout(() => this.render(), 30); },
    stateHtml(kind, icon, title, desc, actions) {
      return '<div class="mjd-state ' + (kind || '') + '">' + ico(icon, 30) + '<div class="mjd-st-t">' + title + '</div>' +
        (desc ? '<div class="mjd-st-d">' + desc + '</div>' : '') + (actions ? '<div class="mjd-st-a">' + actions + '</div>' : '') + '</div>';
    },
    lockedHtml() {
      const A = AUTH_TXT[auth.state] || AUTH_TXT.error;
      const retry = '<button type="button" class="mjd-btn" data-act="retry">' + ico('rotate', 14) + 'Sprawdź ponownie</button>';
      const m = serverMsg ? esc(serverMsg) + ' ' : '';
      if (auth.state === 'checking') return '<div class="mjd-spin">' + this.stateHtml('wait', 'rotate', esc(A.t), 'To potrwa chwilę.') + '</div>';
      if (auth.state === 'pending') return this.stateHtml('wait', 'timer', esc(A.t),
        m + 'Przekaż administratorowi swoje ID konta: <b>' + esc(auth.uid) + '</b>. Po akceptacji kliknij „Sprawdź ponownie” albo odśwież grę.',
        retry + (auth.uid ? '<button type="button" class="mjd-btn ghost" data-act="copy">' + ico('copy', 14) + 'Kopiuj ID</button>' : ''));
      if (auth.state === 'offline' || auth.state === 'error') return this.stateHtml(A.c, 'alert', esc(A.t),
        m + 'Dodatki są dostępne tylko po potwierdzeniu konta.', retry);
      return this.stateHtml('bad', 'lock', esc(A.t), m || 'Brak dostępu do dodatków.', '');
    },
    rowHtml(it) {
      const a = it.a, r = R(a.id), on = it.on, name = a.name || a.id;
      const ver = r.runningVersion || a.version || '';
      const st = rowStatus(r);
      const icon = (a.icon && SVG[a.icon]) ? a.icon : it.c.icon;
      const url = safeUrl(a.homepage);
      return '<div class="mjd-row' + (on ? ' on' : '') + '" data-id="' + esc(a.id) + '">' +
        '<div class="mjd-tile" title="' + esc(it.c.label) + '">' + ico(icon, 15) + '</div>' +
        '<div class="mjd-main" title="' + esc(name + (a.description ? ' — ' + a.description : '')) + '">' +
          '<span class="mjd-name">' + esc(name) + '</span>' +
          (ver ? '<span class="mjd-ver">v' + esc(ver) + '</span>' : '') +
          (a.description ? '<span class="mjd-desc">' + esc(a.description) + '</span>' : '') +
        '</div>' +
        (url ? '<a class="mjd-link" href="' + esc(url) + '" target="_blank" rel="noopener" title="Strona dodatku">' + ico('ext', 14) + '</a>' : '') +
        '<div class="mjd-st' + (st ? ' mjd-s-' + st.c : '') + '"' + (st ? ' title="' + esc(st.tip || st.t) + '"' : '') + '>' +
          (st ? '<span>' + esc(st.t) + '</span><i></i>' : '') + '</div>' +
        '<button type="button" class="mjd-sw" role="switch" aria-checked="' + on + '" aria-label="' + esc((on ? 'Wyłącz ' : 'Włącz ') + name) + '" title="' + (on ? 'Wyłącz' : 'Włącz') + '"><i></i></button>' +
      '</div>';
    },
    render() {
      const root = this.root; if (!root) return;
      const A = AUTH_TXT[auth.state] || AUTH_TXT.error;
      this.authBar.className = 'mjd-auth mjd-a-' + A.c;
      this.authText.innerHTML = esc(A.t) + (auth.uid ? ' <span class="mjd-uid">· ID konta ' + esc(auth.uid) + '</span>' : '');
      root.classList.toggle('checking', auth.state === 'checking');

      if (auth.state !== 'ok' || !cache.addons.length) {
        root.classList.add('locked'); root.classList.remove('need-reload');
        this.side.innerHTML = '';
        this.list.innerHTML = auth.state !== 'ok' ? this.lockedHtml()
          : this.stateHtml('', 'inbox', 'Nie masz jeszcze przypisanych dodatków', 'Gdy administrator przypisze Ci dodatki, pojawią się tutaj.', '');
        return;
      }
      root.classList.remove('locked');

      let needReload = false;
      for (const a of cache.addons) { const r = R(a.id); if (r.status === 'pendingOff' || r.updateReady) needReload = true; }
      root.classList.toggle('need-reload', needReload);

      const words = norm(this.query).split(/\s+/).filter(Boolean);
      const items = cache.addons.map(a => ({ a, c: catOf(a), on: !!state.enabled[a.id] }));
      const matched = items.filter(it => {
        const hay = norm((it.a.name || it.a.id) + ' ' + (it.a.description || '') + ' ' + it.c.label);
        return words.every(w => hay.includes(w));
      });

      // Kategorie: stałe (gdy mają dodatki), potem własne z serwera, „Inne” na końcu.
      const cats = [], seen = {};
      const push = c => { if (!seen[c.id]) { seen[c.id] = c; cats.push(c); } };
      CATS.forEach(c => { if (items.some(it => it.c.id === c.id)) push(c); });
      items.forEach(it => { if (it.c.custom) push(it.c); });
      if (items.some(it => it.c.id === OTHER.id)) push(OTHER);
      if (this.cat !== 'all' && this.cat !== 'on' && !seen[this.cat]) this.cat = 'all';
      const inCat = (it, id) => id === 'all' || (id === 'on' ? it.on : it.c.id === id);
      const catBtn = (id, label, icon) => {
        const n = matched.filter(it => inCat(it, id)).length;
        return '<button type="button" class="mjd-cat' + (this.cat === id ? ' act' : '') + (n ? '' : ' zero') + '" data-cat="' + esc(id) + '" title="' + esc(label) + '">' +
          ico(icon, 15) + '<span class="mjd-cl">' + esc(label) + '</span><span class="mjd-cn">' + n + '</span></button>';
      };
      this.side.innerHTML = catBtn('on', 'Włączone', 'check') + '<div class="mjd-sep"></div>' + catBtn('all', 'Wszystkie', 'layers') +
        cats.map(c => catBtn(c.id, c.label, c.icon)).join('');

      this.search.classList.toggle('has-q', !!words.length);
      this.qn.textContent = words.length ? matched.length + '/' + items.length : String(items.length);

      const shown = matched.filter(it => inCat(it, this.cat));
      const keep = this.list.scrollTop;
      if (shown.length) this.list.innerHTML = shown.map(it => this.rowHtml(it)).join('');
      else if (words.length && matched.length) this.list.innerHTML = this.stateHtml('', 'search', 'Brak wyników w tej kategorii',
        'Pasujące dodatki są w innych kategoriach (' + matched.length + ').', '<button type="button" class="mjd-btn ghost" data-act="all">' + ico('layers', 14) + 'Pokaż wszystkie</button>');
      else if (words.length) this.list.innerHTML = this.stateHtml('', 'search', 'Brak dodatków pasujących do „' + esc(this.query.trim()) + '”',
        'Spróbuj innej nazwy albo krótszego słowa.', '<button type="button" class="mjd-btn ghost" data-act="clear">' + ico('x', 14) + 'Wyczyść wyszukiwanie</button>');
      else if (this.cat === 'on') this.list.innerHTML = this.stateHtml('', 'check', 'Nic nie jest włączone', 'Włącz dodatek przełącznikiem po prawej stronie listy.', '');
      else this.list.innerHTML = this.stateHtml('', 'inbox', 'Pusto', '', '');
      this.list.scrollTop = keep;
    },
    flash(t) {
      if (!this.root) return;
      const f = this.toast; f.textContent = t; f.classList.add('show');
      clearTimeout(this._ft); this._ft = setTimeout(() => f.classList.remove('show'), 1800);
    },
  };

  function injectButton() {
    const holder = document.querySelector('.settings-window .bottom-bar .options-config-buttons');
    if (!holder || holder.querySelector('.mjd-addons-btn')) return;
    const b = gmeBtn('DODATKI', 'mjd-addons-btn');
    b.addEventListener('click', e => { e.stopPropagation(); UI.open(); });
    holder.appendChild(b);
    try { W.$(b).tip('Twoje dodatki'); } catch (e) {}
  }

  /* --------------------------- pływający przycisk m(AI)cin --------------------------- */
  const Widget = {
    el: null,
    area() {   // cały widoczny obszar przeglądarki – przycisk można postawić także poza grą
      return { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight };
    },
    defaultPos() {   // lewy górny róg mapy gry
      const A = this.area(), c = document.querySelector('#GAME_CANVAS');
      const r = c && c.getBoundingClientRect();
      if (r && r.width > 50) return { x: Math.round(r.left - A.left + 8), y: Math.round(r.top - A.top + 8) };
      return { x: 8, y: 8 };
    },
    fits(x, y) {
      const A = this.area(), w = this.el.offsetWidth, h = this.el.offsetHeight;
      return x >= 0 && y >= 0 && x + w <= A.width && y + h <= A.height;
    },
    place(pos, persist) {
      const A = this.area();
      if (!pos || !this.fits(pos.x, pos.y)) pos = this.defaultPos();
      this.pos = pos;
      this.el.style.left = Math.round(A.left + pos.x) + 'px';
      this.el.style.top = Math.round(A.top + pos.y) + 'px';
      if (persist) save(K.widget, pos);
    },
    update() {
      if (!this.el) return;
      const c = auth.state === 'ok' ? 'w-ok' : (['pending', 'checking', 'offline'].includes(auth.state) ? '' : 'w-bad');
      this.el.className = 'mjd-widget' + (c ? ' ' + c : '') + (this.drag ? ' dragging' : '');
    },
    init() {
      if (this.el) return;
      const e = this.el = el('div', 'mjd-widget', '<span class="mjd-w-dot"></span><span>m<span class="mjd-w-ai">(AI)</span>cin</span>');
      e.title = 'Dodatki – kliknij, aby otworzyć; przeciągnij, aby przesunąć; prawy klik – domyślne miejsce';
      document.body.appendChild(e);
      this.place(load(K.widget, null), false);
      this.update();
      let start = null;
      const stop = ev => { ev.stopPropagation(); };
      e.addEventListener('pointerdown', ev => {
        if (ev.button !== 0) return;
        stop(ev); ev.preventDefault();
        start = { mx: ev.clientX, my: ev.clientY, x: this.pos.x, y: this.pos.y, moved: false };
        try { e.setPointerCapture(ev.pointerId); } catch (er) {}
      });
      e.addEventListener('pointermove', ev => {
        if (!start) return;
        const dx = ev.clientX - start.mx, dy = ev.clientY - start.my;
        if (!start.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        if (!start.moved) { start.moved = true; this.drag = true; this.update(); }
        const A = this.area();
        const x = Math.max(0, Math.min(A.width - e.offsetWidth, start.x + dx));
        const y = Math.max(0, Math.min(A.height - e.offsetHeight, start.y + dy));
        this.pos = { x, y };
        e.style.left = Math.round(A.left + x) + 'px'; e.style.top = Math.round(A.top + y) + 'px';
      });
      const end = ev => {
        if (!start) return;
        stop(ev);
        const moved = start.moved; start = null; this.drag = false; this.update();
        try { e.releasePointerCapture(ev.pointerId); } catch (er) {}
        if (moved) save(K.widget, this.pos); else UI.toggle();
      };
      e.addEventListener('pointerup', end);
      e.addEventListener('pointercancel', end);
      ['mousedown', 'click', 'dblclick', 'contextmenu'].forEach(t => e.addEventListener(t, stop));
      e.addEventListener('contextmenu', ev => { ev.preventDefault(); this.place(null, true); });   // prawy klik = powrót na domyślne miejsce
      // Po zmianie rozmiaru okna: gdy przycisk wypada poza widoczny obszar – wróć do lewego górnego rogu gry.
      let t = null;
      addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => this.place(load(K.widget, null), false), 150); });
    },
  };

  function initUi() {
    addCss(); injectButton();
    let queued = false;
    new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; injectButton(); }); })
      .observe(document.body, { childList: true, subtree: true });
    try { GM_registerMenuCommand('Otwórz menedżer dodatków', () => UI.open()); } catch (e) {}
    try { GM_registerMenuCommand('Przywróć przycisk m(AI)cin na domyślne miejsce', () => { save(K.widget, null); Widget.place(null, true); }); } catch (e) {}
    // Przycisk pojawia się, gdy interfejs gry jest gotowy.
    waitFor(() => W.Engine && W.Engine.hero && document.querySelector('#GAME_CANVAS'), 60000).then(() => Widget.init());
  }

  /* --------------------------- start --------------------------- */
  const onDom = () => { initUi(); syncWithServer(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onDom, { once: true }); else onDom();
})();
