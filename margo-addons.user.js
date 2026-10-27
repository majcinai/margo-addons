// ==UserScript==
// @name         Margonem – Dodatki (menedżer)
// @namespace    majcinai
// @version      0.3.4
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

  const MANAGER_VERSION = '0.3.4';

  // ADRES SERWERA – ustaw po wdrożeniu (np. https://majcin-addons.twojanazwa.workers.dev)
  const SERVER_URL = 'https://margo-dodatki.majcin94.workers.dev';

  const IDLE_DELAY_MS = 1000;

  /* --------------------------- pamięć --------------------------- */
  const K = {
    state: 'mm.state',
    cache: 'mm.cache',
    userLabel: 'mm.userLabel',
    widget: 'mm.widgetPos',
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
        onload: r => { let d = {}; try { d = JSON.parse(r.responseText); } catch (e) {} resolve({ status: r.status, data: d }); },
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
  function setAuth(st, msg, uid) { auth.state = st; auth.msg = msg || ''; if (uid != null && uid !== '') auth.uid = String(uid); serverMsg = (st === 'ok' || st === 'checking') ? null : (msg || null); UI.refresh(); Widget.update(); }
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
    try { ch = await post('/api/challenge', {}); } catch (e) { return setAuth('offline', 'Brak połączenia z serwerem dodatków – działają dodatki zapamiętane wcześniej.'); }
    if (ch.status !== 200 || !ch.data.nonce) return setAuth('offline', 'Serwer dodatków nie odpowiada (' + ch.status + ').');
    const proof = await margonemProof(ch.data.nonce);
    if (!proof) return setAuth('error', 'Nie udało się potwierdzić konta w Margonem. Upewnij się, że jesteś zalogowany na margonem.pl, i odśwież grę.');
    auth.uid = String(proof.user_id);
    let res;
    try { res = await post('/api/login', { nonce: ch.data.nonce, proof, nick: hi.nick, world: worldName(), managerVersion: MANAGER_VERSION }); }
    catch (e) { return setAuth('offline', 'Brak połączenia z serwerem dodatków – działają dodatki zapamiętane wcześniej.'); }
    const d = res.data || {};
    if (res.status === 403 && ['pending', 'rejected', 'revoked'].includes(d.error)) { dropAccess(); return setAuth(d.error, d.message, d.uid); }
    if (res.status !== 200 || !d.ok) return setAuth('error', d.message || ('Błąd serwera (' + res.status + ')'));
    save(K.userLabel, (d.player && d.player.label) || '');
    const incoming = d.addons || [];
    for (const a of incoming) {
      const old = cache.addons.find(x => x.id === a.id);
      if (old && bareCode(old.code) !== bareCode(a.code) && R(a.id).status === 'running') R(a.id).updateReady = a.version || '?';
    }
    for (const old of cache.addons) if (!incoming.find(a => a.id === old.id) && R(old.id).status === 'running') R(old.id).status = 'pendingOff';
    cache = { addons: incoming, at: Date.now() };
    save(K.cache, cache);
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
  const CSS = `
  .mjd-addons-btn.button{position:absolute!important;left:50%;top:3px;transform:translateX(-50%);width:84px;min-width:0!important;margin:0!important}
  .mjd-wnd{position:relative;width:390px;min-height:220px;color:#e6d3a3;font-size:12px}
  .mjd-wnd>.graphic-background{position:absolute;inset:0;z-index:0}
  .mjd-wnd .mjd-inner{position:relative;z-index:1;padding:6px 6px 44px}
  .mjd-wnd h2{position:relative;margin:4px 0 6px;height:24px;line-height:24px;text-align:left;padding-left:10px;font-size:12px;color:#e6d3a3}
  .mjd-wnd h2>div{position:absolute;inset:0;z-index:-1}
  .mjd-auth{display:flex;gap:7px;align-items:center;margin:0 2px 8px;padding:6px 8px;background:rgba(0,0,0,.28);border:1px solid rgba(230,211,163,.12);border-radius:4px;font-size:11px}
  .mjd-adot{width:8px;height:8px;border-radius:50%;flex:none;background:#e0c14a}
  .mjd-a-ok .mjd-adot{background:#6fd04a;box-shadow:0 0 5px #6fd04a}.mjd-a-ok{color:#9fe07f}
  .mjd-a-wait{color:#e0c14a}
  .mjd-a-bad .mjd-adot{background:#e0564a}.mjd-a-bad{color:#ff8a7a}
  .mjd-atext{flex:1;min-width:0}.mjd-uid{color:#9d8f6d}
  .mjd-retry{flex:none;width:24px;height:22px;padding:0;cursor:pointer;background:#0e0b07;color:#e6d3a3;border:1px solid #3a2f1c;border-radius:4px;font-size:13px;line-height:1;opacity:.7}
  .mjd-retry:hover{opacity:1;border-color:#8a6d2f}
  .mjd-msg{margin:0 2px 8px;padding:7px 9px;border-radius:4px;background:rgba(90,20,20,.35);border:1px solid #6e2e2a;color:#ffbdb5;font-size:11px}
  .mjd-scroll,.mjd-scroll .mjd-list{max-height:340px}
  .mjd-scroll{position:relative}
  .mjd-scroll .mjd-list{padding-right:10px}
  .mjd-item{padding:6px 8px 7px;margin:0 2px 4px;border-radius:3px;background:rgba(0,0,0,.28);border:1px solid rgba(230,211,163,.10)}
  .mjd-item.on{border-color:rgba(120,200,90,.35)}
  .mjd-top{display:flex;align-items:center;gap:6px}
  .mjd-top .c-checkbox{flex:1;min-width:0}
  .mjd-top .c-checkbox__label{font-weight:bold;color:#f0e0b0!important}
  .mjd-ver{color:#9d8f6d;font-size:11px;white-space:nowrap}
  .mjd-link{color:#9d8f6d;text-decoration:none;font-size:13px;padding:0 2px}.mjd-link:hover{color:#f0e0b0}
  .mjd-desc{color:#b9a980;margin:3px 0 0 26px;line-height:1.35}
  .mjd-status{margin:4px 0 0 26px;font-size:11px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .mjd-dot{width:7px;height:7px;border-radius:50%;background:#777;display:inline-block;flex:none}
  .mjd-s-running .mjd-dot{background:#6fd04a;box-shadow:0 0 5px #6fd04a}.mjd-s-running{color:#9fe07f}
  .mjd-s-pending .mjd-dot,.mjd-s-loading .mjd-dot{background:#e0c14a}.mjd-s-pending,.mjd-s-loading{color:#e0c14a}
  .mjd-s-error .mjd-dot{background:#e0564a}.mjd-s-error{color:#ff8a7a}
  .mjd-s-off{color:#8a7f66}
  .mjd-upd{color:#7fc8ff}
  .mjd-search{position:relative;display:flex;align-items:center;margin:0 2px 8px}
  .mjd-search .mjd-q{flex:1;min-width:0;background:#0e0b07;color:#e6d3a3;border:1px solid #3a2f1c;border-radius:4px;padding:5px 60px 5px 8px;font-size:12px;outline:none}
  .mjd-search .mjd-q:focus{border-color:#8a6d2f}
  .mjd-qx{position:absolute;right:38px;color:#9d8f6d;cursor:pointer;font-size:15px;line-height:1;padding:0 3px;display:none}
  .mjd-search.has-q .mjd-qx{display:block}.mjd-qx:hover{color:#f0e0b0}
  .mjd-qn{position:absolute;right:7px;color:#6f6450;font-size:10px;pointer-events:none}
  .mjd-empty{padding:20px;text-align:center;color:#9d8f6d}
  .mjd-bottom{position:absolute;left:0;right:0;bottom:6px;display:flex;justify-content:center;gap:8px;z-index:1}
  .mjd-bottom .button{position:relative}
  .mjd-reload{display:none}.mjd-wnd.need-reload .mjd-reload{display:block}
  .mjd-flash{position:absolute;left:0;right:0;bottom:40px;text-align:center;color:#9fe07f;font-size:11px;opacity:0;transition:opacity .3s;z-index:1;pointer-events:none}
  .mjd-flash.show{opacity:1}
  .mjd-widget{position:fixed;z-index:450;left:0;top:0;display:flex;align-items:center;gap:5px;height:24px;padding:0 9px 0 7px;border-radius:12px;
    background:linear-gradient(#2a2114,#140f09);border:1px solid #8a6d2f;box-shadow:0 2px 6px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,230,160,.15);
    color:#e6d3a3;font:bold 12px/1 Arial,sans-serif;letter-spacing:.2px;cursor:pointer;user-select:none;touch-action:none;white-space:nowrap;opacity:.88;transition:opacity .15s,box-shadow .15s}
  .mjd-widget:hover{opacity:1;box-shadow:0 2px 8px rgba(0,0,0,.7),0 0 6px rgba(230,196,100,.45)}
  .mjd-widget.dragging{cursor:grabbing;opacity:1}
  .mjd-widget .mjd-w-ai{color:#f2c94c;text-shadow:0 0 4px rgba(242,201,76,.55)}
  .mjd-widget .mjd-w-dot{width:7px;height:7px;border-radius:50%;background:#e0c14a;flex:none}
  .mjd-widget.w-ok .mjd-w-dot{background:#6fd04a;box-shadow:0 0 4px #6fd04a}
  .mjd-widget.w-bad .mjd-w-dot{background:#e0564a}
  `;
  function addCss() { const s = document.createElement('style'); s.id = 'mjd-addons-css'; s.textContent = CSS; (document.head || document.documentElement).appendChild(s); }

  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const gmeBtn = (label, cls) => { const b = el('div', 'button green small ' + (cls || '')); b.innerHTML = '<div class="background"></div><div class="label">' + esc(label) + '</div>'; return b; };

  const STATUS = {
    running: { c: 'running', t: 'Działa' }, loading: { c: 'loading', t: 'Uruchamianie…' },
    off: { c: 'off', t: 'Wyłączony' }, pendingOff: { c: 'pending', t: 'Wyłączy się po odświeżeniu gry' },
    error: { c: 'error', t: 'Błąd' },
  };

  const AUTH_TXT = {
    checking: { c: 'wait', t: 'Sprawdzam konto Margonem…' },
    ok: { c: 'ok', t: 'Dostęp potwierdzony' },
    pending: { c: 'wait', t: 'Czeka na akceptację administratora' },
    rejected: { c: 'bad', t: 'Dostęp nieprzyznany' },
    revoked: { c: 'bad', t: 'Dostęp cofnięty' },
    offline: { c: 'wait', t: 'Serwer niedostępny' },
    error: { c: 'bad', t: 'Nie udało się potwierdzić konta' },
  };

  const UI = {
    wnd: null, root: null, list: null, _t: null, query: '',
    open() {
      const E = W.Engine, $ = W.$; if (!E || !E.windowManager || !$) return;
      if (this.wnd) { this.wnd.show(); this.visible = true; this.toTop(); this.refresh(); return; }
      const root = el('div', 'mjd-wnd');
      root.innerHTML =
        '<div class="graphic-background interface-element-middle-1-background"></div>' +
        '<div class="mjd-inner">' +
          '<h2><div class="interface-element-header-1-background-stretch"></div><span>Twoje dodatki</span></h2>' +
          '<div class="mjd-auth"><span class="mjd-adot"></span><span class="mjd-atext"></span><button type="button" class="mjd-retry" title="Sprawdź dostęp ponownie">&#8635;</button></div>' +
          '<div class="mjd-msg" style="display:none"></div>' +
          '<div class="mjd-search"><input type="text" class="mjd-q" placeholder="Szukaj dodatku…" spellcheck="false" autocomplete="off"><span class="mjd-qx" title="Wyczyść">&times;</span><span class="mjd-qn"></span></div>' +
          '<div class="scroll-wrapper mjd-scroll"><div class="scroll-pane mjd-list"></div></div>' +
        '</div>' +
        '<div class="mjd-flash"></div>' +
        '<div class="mjd-bottom"></div>';
      const bottom = root.querySelector('.mjd-bottom');
      const bReload = gmeBtn('Odśwież grę', 'mjd-reload');
      bReload.addEventListener('click', () => location.reload());
      bottom.append(bReload);

      root.querySelector('.mjd-retry').addEventListener('click', () => { this.flash('Sprawdzam dostęp…'); syncWithServer(); });

      const q = root.querySelector('.mjd-q');
      // Pisanie w wyszukiwarce nie może uruchamiać skrótów klawiszowych gry.
      ['keydown', 'keyup', 'keypress'].forEach(t => q.addEventListener(t, ev => { ev.stopPropagation(); if (t === 'keydown' && ev.key === 'Escape') { q.value = ''; this.query = ''; this.render(); } }));
      q.addEventListener('input', () => { this.query = q.value; this.render(); });
      root.querySelector('.mjd-qx').addEventListener('click', () => { q.value = ''; this.query = ''; this.render(); q.focus(); });
      this.root = root; this.list = root.querySelector('.mjd-list'); this.scroll = root.querySelector('.mjd-scroll');
      this.wnd = E.windowManager.add({ content: $(root), nameWindow: 'MAJCINAI_ADDONS_MANAGER', title: 'Dodatki', onclose: () => { this.wnd.hide(); this.visible = false; } });
      this.visible = true;
      this.wnd.addToAlertLayer(); this.wnd.center(); this.wnd.show(); this.toTop();
      try { $(this.scroll).addScrollBar({ track: true }); this.hasBar = true; } catch (e) { this.scroll.style.overflowY = 'auto'; this.list.style.overflowY = 'auto'; }
      this.refresh();
    },
    toggle() { if (this.wnd && this.visible) { this.wnd.hide(); this.visible = false; } else this.open(); },
    toTop() { try { this.wnd.setWndOnPeak(); } catch (e) {} },
    refresh() { if (!this.list) return; clearTimeout(this._t); this._t = setTimeout(() => this.render(), 30); },
    render() {
      const list = this.list; if (!list) return;
      const msg = this.root.querySelector('.mjd-msg');
      if (serverMsg) { msg.style.display = 'block'; msg.textContent = serverMsg; } else msg.style.display = 'none';
      const A = AUTH_TXT[auth.state] || AUTH_TXT.error;
      const bar = this.root.querySelector('.mjd-auth');
      bar.className = 'mjd-auth mjd-a-' + A.c;
      bar.querySelector('.mjd-atext').innerHTML = esc(A.t) + (auth.uid ? ' <span class="mjd-uid">· ID konta: ' + esc(auth.uid) + '</span>' : '');
      list.innerHTML = ''; let needReload = false;
      this.root.querySelector('.mjd-search').style.display = 'none';
      if (['pending', 'rejected', 'revoked'].includes(auth.state)) {
        const hint = auth.state === 'pending' ? 'Przekaż administratorowi swoje ID konta: <b>' + esc(auth.uid) + '</b>. Po akceptacji kliknij &#8635; albo odśwież grę.' : 'Brak dostępu do dodatków.';
        list.appendChild(el('div', 'mjd-empty', hint)); this.root.classList.remove('need-reload'); this.updBar(); return;
      }
      if (!cache.addons.length) { list.appendChild(el('div', 'mjd-empty', auth.state === 'checking' ? 'Sprawdzam dostęp…' : (auth.state === 'ok' ? 'Nie masz jeszcze przypisanych dodatków.' : 'Brak dostępnych dodatków.'))); this.root.classList.remove('need-reload'); this.updBar(); return; }
      for (const a of cache.addons) { const r = R(a.id); if (r.status === 'pendingOff' || r.updateReady) needReload = true; }
      const norm = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
      const words = norm(this.query).split(/\s+/).filter(Boolean);
      const shown = cache.addons.filter(a => { const hay = norm((a.name || a.id) + ' ' + (a.description || '')); return words.every(w => hay.includes(w)); });
      const search = this.root.querySelector('.mjd-search');
      search.style.display = '';
      search.classList.toggle('has-q', !!words.length);
      search.querySelector('.mjd-qn').textContent = words.length ? shown.length + '/' + cache.addons.length : cache.addons.length + '';
      if (!shown.length) list.appendChild(el('div', 'mjd-empty', 'Brak dodatków pasujących do „' + esc(this.query.trim()) + '”.'));
      for (const a of shown) {
        const on = !!state.enabled[a.id], r = R(a.id);
        const ver = r.runningVersion || a.version || '';
        const item = el('div', 'mjd-item' + (on ? ' on' : ''));
        const cb = 'mjd-cb-' + a.id;
        item.innerHTML =
          '<div class="mjd-top"><div class="checkbox-custom c-checkbox"><input type="checkbox" id="' + cb + '"' + (on ? ' checked' : '') + '>' +
          '<label for="' + cb + '" class="c-checkbox__label">' + esc(a.name || a.id) + '</label></div>' +
          (ver ? '<span class="mjd-ver">v' + esc(ver) + '</span>' : '') +
          (a.homepage ? '<a class="mjd-link" href="' + esc(a.homepage) + '" target="_blank" rel="noopener">↗</a>' : '') + '</div>' +
          (a.description ? '<div class="mjd-desc">' + esc(a.description) + '</div>' : '');
        const s = STATUS[r.status] || STATUS.off;
        const st = el('div', 'mjd-status mjd-s-' + s.c);
        st.innerHTML = '<span class="mjd-dot"></span><span>' + esc(s.t + (r.status === 'error' && r.error ? ': ' + r.error : '')) + '</span>';
        if (r.updateReady) st.innerHTML += '<span class="mjd-upd">• nowa wersja v' + esc(r.updateReady) + ' po odświeżeniu</span>';
        item.appendChild(st);
        item.querySelector('input').addEventListener('change', e => setEnabled(a.id, e.target.checked));
        list.appendChild(item);
      }
      this.root.classList.toggle('need-reload', needReload);
      this.updBar();
    },
    updBar() { if (this.hasBar) try { W.$(this.scroll).trigger('update'); } catch (e) {} },
    flash(t) { if (!this.root) return; const f = this.root.querySelector('.mjd-flash'); f.textContent = t; f.classList.add('show'); setTimeout(() => f.classList.remove('show'), 1800); },
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
  for (const a of cache.addons) if (state.enabled[a.id]) startAddon(a);

  const onDom = () => { initUi(); syncWithServer(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onDom, { once: true }); else onDom();
})();
