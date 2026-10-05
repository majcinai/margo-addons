// ==UserScript==
// @name         Margonem – Dodatki (menedżer)
// @namespace    majcinai
// @version      0.2.2
// @description  Menedżer dodatków Margonem: włączanie i wyłączanie dodatków z okna Konfiguracji w grze. Dodatki wydawane są po kluczu dostępu z prywatnego serwera i aktualizują się same.
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
// @connect      workers.dev
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (W.top !== W.self) return;
  if (W.MargoAddons && W.MargoAddons.__manager) return;

  const MANAGER_VERSION = '0.2.2';

  // ADRES SERWERA – ustaw po wdrożeniu (np. https://majcin-addons.twojanazwa.workers.dev)
  const SERVER_URL = 'https://margo-dodatki.majcin94.workers.dev';

  const IDLE_DELAY_MS = 1000;

  /* --------------------------- pamięć --------------------------- */
  const K = {
    key: 'mm.key',
    state: 'mm.state',
    cache: 'mm.cache',
    userLabel: 'mm.userLabel',
    data: (id, k) => 'a.' + id + '.' + k,
  };
  const load = (k, def) => { try { const v = GM_getValue(k); return v === undefined ? def : v; } catch (e) { return def; } };
  const save = (k, v) => { try { GM_setValue(k, v); } catch (e) {} };

  let accessKey = String(load(K.key, '') || '');
  const state = Object.assign({ enabled: {} }, load(K.state, {}));
  const saveState = () => save(K.state, state);
  let cache = load(K.cache, null) || { addons: [], at: 0 };
  let serverMsg = null;

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

  async function syncWithServer() {
    if (!accessKey) { serverMsg = null; UI.refresh(); return; }
    await waitFor(() => heroInfo().account);
    const hi = heroInfo();
    let res;
    try { res = await post('/api/session', { key: accessKey, account: hi.account, nick: hi.nick, world: worldName(), managerVersion: MANAGER_VERSION }); }
    catch (e) { serverMsg = null; UI.refresh(); return; }
    if (res.status !== 200 || !res.data.ok) {
      serverMsg = res.data && res.data.message ? res.data.message : 'Błąd serwera (' + res.status + ')';
      UI.refresh(); return;
    }
    serverMsg = null;
    save(K.userLabel, (res.data.user && res.data.user.label) || '');
    const incoming = res.data.addons || [];
    for (const a of incoming) {
      const old = cache.addons.find(x => x.id === a.id);
      if (old && bareCode(old.code) !== bareCode(a.code) && R(a.id).status === 'running') R(a.id).updateReady = a.version || '?';
    }
    for (const old of cache.addons) if (!incoming.find(a => a.id === old.id) && R(old.id).status === 'running') R(old.id).status = 'pendingOff';
    cache = { addons: incoming, at: Date.now() };
    save(K.cache, cache);
    for (const a of incoming) if (state.enabled[a.id] && R(a.id).status === 'off') startAddon(a);
    UI.refresh();
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
  .mm-addons-btn.button{position:absolute!important;left:50%;top:3px;transform:translateX(-50%);width:84px;min-width:0!important;margin:0!important}
  .mm-wnd{position:relative;width:390px;min-height:220px;color:#e6d3a3;font-size:12px}
  .mm-wnd>.graphic-background{position:absolute;inset:0;z-index:0}
  .mm-wnd .mm-inner{position:relative;z-index:1;padding:6px 6px 44px}
  .mm-wnd h2{position:relative;margin:4px 0 6px;height:24px;line-height:24px;text-align:left;padding-left:10px;font-size:12px;color:#e6d3a3}
  .mm-wnd h2>div{position:absolute;inset:0;z-index:-1}
  .mm-keybar{display:flex;gap:6px;align-items:center;margin:0 2px 8px;padding:6px;background:rgba(0,0,0,.28);border:1px solid rgba(230,211,163,.12);border-radius:4px}
  .mm-eye{flex:none;width:28px;height:26px;padding:0;cursor:pointer;background:#0e0b07;color:#e6d3a3;border:1px solid #3a2f1c;border-radius:4px;font-size:14px;line-height:1;opacity:.6}
  .mm-eye:hover,.mm-eye.on{opacity:1;border-color:#8a6d2f}
  .mm-keybar input{flex:1;min-width:0;background:#0e0b07;color:#e6d3a3;border:1px solid #3a2f1c;border-radius:4px;padding:5px 7px;font-family:ui-monospace,monospace;font-size:11px}
  .mm-msg{margin:0 2px 8px;padding:7px 9px;border-radius:4px;background:rgba(90,20,20,.35);border:1px solid #6e2e2a;color:#ffbdb5;font-size:11px}
  .mm-scroll,.mm-scroll .mm-list{max-height:340px}
  .mm-scroll{position:relative}
  .mm-scroll .mm-list{padding-right:10px}
  .mm-item{padding:6px 8px 7px;margin:0 2px 4px;border-radius:3px;background:rgba(0,0,0,.28);border:1px solid rgba(230,211,163,.10)}
  .mm-item.on{border-color:rgba(120,200,90,.35)}
  .mm-top{display:flex;align-items:center;gap:6px}
  .mm-top .c-checkbox{flex:1;min-width:0}
  .mm-top .c-checkbox__label{font-weight:bold;color:#f0e0b0!important}
  .mm-ver{color:#9d8f6d;font-size:11px;white-space:nowrap}
  .mm-link{color:#9d8f6d;text-decoration:none;font-size:13px;padding:0 2px}.mm-link:hover{color:#f0e0b0}
  .mm-desc{color:#b9a980;margin:3px 0 0 26px;line-height:1.35}
  .mm-status{margin:4px 0 0 26px;font-size:11px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .mm-dot{width:7px;height:7px;border-radius:50%;background:#777;display:inline-block;flex:none}
  .mm-s-running .mm-dot{background:#6fd04a;box-shadow:0 0 5px #6fd04a}.mm-s-running{color:#9fe07f}
  .mm-s-pending .mm-dot,.mm-s-loading .mm-dot{background:#e0c14a}.mm-s-pending,.mm-s-loading{color:#e0c14a}
  .mm-s-error .mm-dot{background:#e0564a}.mm-s-error{color:#ff8a7a}
  .mm-s-off{color:#8a7f66}
  .mm-upd{color:#7fc8ff}
  .mm-empty{padding:20px;text-align:center;color:#9d8f6d}
  .mm-bottom{position:absolute;left:0;right:0;bottom:6px;display:flex;justify-content:center;gap:8px;z-index:1}
  .mm-bottom .button{position:relative}
  .mm-reload{display:none}.mm-wnd.need-reload .mm-reload{display:block}
  .mm-flash{position:absolute;left:0;right:0;bottom:40px;text-align:center;color:#9fe07f;font-size:11px;opacity:0;transition:opacity .3s;z-index:1;pointer-events:none}
  .mm-flash.show{opacity:1}
  `;
  function addCss() { const s = document.createElement('style'); s.id = 'mm-addons-css'; s.textContent = CSS; (document.head || document.documentElement).appendChild(s); }

  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const gmeBtn = (label, cls) => { const b = el('div', 'button green small ' + (cls || '')); b.innerHTML = '<div class="background"></div><div class="label">' + esc(label) + '</div>'; return b; };

  const STATUS = {
    running: { c: 'running', t: 'Działa' }, loading: { c: 'loading', t: 'Uruchamianie…' },
    off: { c: 'off', t: 'Wyłączony' }, pendingOff: { c: 'pending', t: 'Wyłączy się po odświeżeniu gry' },
    error: { c: 'error', t: 'Błąd' },
  };

  const UI = {
    wnd: null, root: null, list: null, _t: null,
    open() {
      const E = W.Engine, $ = W.$; if (!E || !E.windowManager || !$) return;
      if (this.wnd) { this.wnd.show(); this.toTop(); this.refresh(); return; }
      const root = el('div', 'mm-wnd');
      root.innerHTML =
        '<div class="graphic-background interface-element-middle-1-background"></div>' +
        '<div class="mm-inner">' +
          '<h2><div class="interface-element-header-1-background-stretch"></div><span>Twoje dodatki</span></h2>' +
          '<div class="mm-keybar"><input type="password" class="mm-key" placeholder="Klucz dostępu (MA-XXXX-XXXX-XXXX)" spellcheck="false" autocomplete="off" data-lpignore="true"><button type="button" class="mm-eye" title="Pokaż / ukryj klucz" aria-label="Pokaż / ukryj klucz">&#128065;</button></div>' +
          '<div class="mm-msg" style="display:none"></div>' +
          '<div class="scroll-wrapper mm-scroll"><div class="scroll-pane mm-list"></div></div>' +
        '</div>' +
        '<div class="mm-flash"></div>' +
        '<div class="mm-bottom"></div>';
      const bottom = root.querySelector('.mm-bottom');
      const bReload = gmeBtn('Odśwież grę', 'mm-reload');
      bReload.addEventListener('click', () => location.reload());
      bottom.append(bReload);

      const keyInput = root.querySelector('.mm-key'); keyInput.value = accessKey;
      const KEY_RE = /^MA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
      const maybeSave = force => {
        const v = (keyInput.value || '').trim().toUpperCase();
        if (v === accessKey) return;
        if (force || KEY_RE.test(v)) this.saveKey();
      };
      keyInput.addEventListener('input', () => maybeSave(false));
      keyInput.addEventListener('change', () => maybeSave(true));
      keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') maybeSave(true); });
      const eye = root.querySelector('.mm-eye');
      eye.addEventListener('click', () => {
        const show = keyInput.type === 'password';
        keyInput.type = show ? 'text' : 'password';
        eye.classList.toggle('on', show);
      });

      this.root = root; this.list = root.querySelector('.mm-list'); this.scroll = root.querySelector('.mm-scroll');
      this.wnd = E.windowManager.add({ content: $(root), nameWindow: 'MAJCINAI_ADDONS_MANAGER', title: 'Dodatki', onclose: () => this.wnd.hide() });
      this.wnd.addToAlertLayer(); this.wnd.center(); this.wnd.show(); this.toTop();
      try { $(this.scroll).addScrollBar({ track: true }); this.hasBar = true; } catch (e) { this.scroll.style.overflowY = 'auto'; this.list.style.overflowY = 'auto'; }
      this.refresh();
    },
    toTop() { try { this.wnd.setWndOnPeak(); } catch (e) {} },
    saveKey() {
      const v = (this.root.querySelector('.mm-key').value || '').trim().toUpperCase();
      accessKey = v; save(K.key, v); this.root.querySelector('.mm-key').type = 'password'; this.root.querySelector('.mm-eye').classList.remove('on'); this.flash(v ? 'Klucz zapisany – sprawdzam…' : 'Klucz usunięty');
      syncWithServer();
    },
    refresh() { if (!this.list) return; clearTimeout(this._t); this._t = setTimeout(() => this.render(), 30); },
    render() {
      const list = this.list; if (!list) return;
      const msg = this.root.querySelector('.mm-msg');
      if (serverMsg) { msg.style.display = 'block'; msg.textContent = serverMsg; } else msg.style.display = 'none';
      list.innerHTML = ''; let needReload = false;
      if (!accessKey) { list.appendChild(el('div', 'mm-empty', 'Wpisz klucz dostępu, aby zobaczyć swoje dodatki.')); this.root.classList.remove('need-reload'); this.updBar(); return; }
      if (!cache.addons.length) { list.appendChild(el('div', 'mm-empty', serverMsg ? 'Brak dostępnych dodatków.' : 'Ładowanie listy dodatków…')); this.root.classList.remove('need-reload'); this.updBar(); return; }
      for (const a of cache.addons) {
        const on = !!state.enabled[a.id], r = R(a.id);
        const ver = r.runningVersion || a.version || '';
        const item = el('div', 'mm-item' + (on ? ' on' : ''));
        const cb = 'mm-cb-' + a.id;
        item.innerHTML =
          '<div class="mm-top"><div class="checkbox-custom c-checkbox"><input type="checkbox" id="' + cb + '"' + (on ? ' checked' : '') + '>' +
          '<label for="' + cb + '" class="c-checkbox__label">' + esc(a.name || a.id) + '</label></div>' +
          (ver ? '<span class="mm-ver">v' + esc(ver) + '</span>' : '') +
          (a.homepage ? '<a class="mm-link" href="' + esc(a.homepage) + '" target="_blank" rel="noopener">↗</a>' : '') + '</div>' +
          (a.description ? '<div class="mm-desc">' + esc(a.description) + '</div>' : '');
        const s = STATUS[r.status] || STATUS.off;
        const st = el('div', 'mm-status mm-s-' + s.c);
        st.innerHTML = '<span class="mm-dot"></span><span>' + esc(s.t + (r.status === 'error' && r.error ? ': ' + r.error : '')) + '</span>';
        if (r.updateReady) st.innerHTML += '<span class="mm-upd">• nowa wersja v' + esc(r.updateReady) + ' po odświeżeniu</span>';
        item.appendChild(st);
        if (r.status === 'pendingOff' || r.updateReady) needReload = true;
        item.querySelector('input').addEventListener('change', e => setEnabled(a.id, e.target.checked));
        list.appendChild(item);
      }
      this.root.classList.toggle('need-reload', needReload);
      this.updBar();
    },
    updBar() { if (this.hasBar) try { W.$(this.scroll).trigger('update'); } catch (e) {} },
    flash(t) { if (!this.root) return; const f = this.root.querySelector('.mm-flash'); f.textContent = t; f.classList.add('show'); setTimeout(() => f.classList.remove('show'), 1800); },
  };

  function injectButton() {
    const holder = document.querySelector('.settings-window .bottom-bar .options-config-buttons');
    if (!holder || holder.querySelector('.mm-addons-btn')) return;
    const b = gmeBtn('DODATKI', 'mm-addons-btn');
    b.addEventListener('click', e => { e.stopPropagation(); UI.open(); });
    holder.appendChild(b);
    try { W.$(b).tip('Twoje dodatki'); } catch (e) {}
  }

  function initUi() {
    addCss(); injectButton();
    let queued = false;
    new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; injectButton(); }); })
      .observe(document.body, { childList: true, subtree: true });
    try { GM_registerMenuCommand('Otwórz menedżer dodatków', () => UI.open()); } catch (e) {}
  }

  /* --------------------------- start --------------------------- */
  for (const a of cache.addons) if (state.enabled[a.id]) startAddon(a);

  const onDom = () => { initUi(); syncWithServer(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onDom, { once: true }); else onDom();
})();