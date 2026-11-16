/* app-update.js — keeps an installed web app on the latest version.
 * Part of George's app-update kit (~/Developer/app-update-kit). Do not remove:
 * without it, home-screen copies of this app can stay on an old version.
 *
 * What it does
 *  1. Registers the service worker (sw.js beside this file), which loads code
 *     network-first, so every fresh launch gets the newest files and the app
 *     still opens offline.
 *  2. Remembers a fingerprint (ETag / Last-Modified) of the files this page
 *     loaded. When the app comes back to the foreground, and every 30 minutes
 *     while open, it asks the server whether any of them changed.
 *  3. If they did: when you come back after 5+ minutes away it reloads quietly
 *     (it is effectively a fresh launch); otherwise it shows a small
 *     "New version · Reload" pill, so nothing is lost mid-task.
 *
 * Optional settings (read when needed, so the app can set them at any time):
 *   <script src="app-update.js" data-sw="none" defer>  — the app registers its own worker
 *   window.APP_UPDATE = {
 *     canReload: () => true,  // return false while reloading would lose work
 *     onUpdate: null,         // function(reload) to show your own prompt instead
 *   };
 * Debug: window.__appUpdate.check() resolves to true if an update is waiting.
 */
(function () {
  'use strict';
  if (window.__appUpdate || !('fetch' in window)) return;

  var me = document.currentScript;
  var cfg = function () { return window.APP_UPDATE || {}; };
  var swAttr = me && me.dataset ? me.dataset.sw : undefined;
  var SW = swAttr === 'none' || swAttr === 'false' ? false : swAttr || 'sw.js';
  var CHECK_EVERY = 30 * 60 * 1000;
  var AWAY_FOR_QUIET_RELOAD = 5 * 60 * 1000;
  var MAX_FILES = 40;
  var CODE = /\.(?:html?|m?js|css|json|webmanifest)(?:$|\?)/i;
  var base = me ? new URL('.', me.src) : new URL('.', location.href);

  var known = new Map(); // url -> tag
  var waiting = false;
  var hiddenAt = 0;
  var checking = null;

  function canReload() {
    try { return cfg().canReload ? cfg().canReload() !== false : true; } catch (e) { return true; }
  }

  function trackedUrls() {
    var urls = [location.href.split('#')[0]];
    var add = function (raw) {
      try {
        var u = new URL(raw, location.href);
        if (u.origin !== location.origin || !CODE.test(u.pathname + u.search)) return;
        u.hash = '';
        if (urls.indexOf(u.href) < 0) urls.push(u.href);
      } catch (e) { /* ignore */ }
    };
    document.querySelectorAll('script[src],link[rel~="stylesheet"][href],link[rel="modulepreload"][href]')
      .forEach(function (el) { add(el.src || el.href); });
    if (performance.getEntriesByType) performance.getEntriesByType('resource').forEach(function (e) { add(e.name); });
    return urls.slice(0, MAX_FILES);
  }

  function tagOf(url) {
    return fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) return null;
      return r.headers.get('etag') || r.headers.get('last-modified') || r.headers.get('content-length') || null;
    }, function () { return null; });
  }

  // Resolves true if any file loaded by this page has changed on the server.
  function check() {
    if (waiting) return Promise.resolve(true);
    if (checking) return checking;
    if (navigator.onLine === false) return Promise.resolve(false);
    checking = Promise.all(trackedUrls().map(function (url) {
      return tagOf(url).then(function (tag) {
        if (tag === null) return false;
        if (!known.has(url)) { known.set(url, tag); return false; }
        return known.get(url) !== tag;
      });
    })).then(function (changed) {
      checking = null;
      if (changed.indexOf(true) >= 0) waiting = true;
      return waiting;
    }, function () { checking = null; return false; });
    return checking;
  }

  function reload() {
    // Make sure the worker fetches fresh copies, then reload.
    var go = function () { location.reload(); };
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
      navigator.serviceWorker.getRegistration().then(function (reg) {
        return reg ? reg.update().catch(function () {}) : null;
      }).then(go, go);
    } else {
      go();
    }
  }

  var pill = null;
  function showPill() {
    if (cfg().onUpdate) { try { cfg().onUpdate(reload); return; } catch (e) { /* fall back */ } }
    if (pill) return;
    var dark = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
    pill = document.createElement('div');
    pill.setAttribute('role', 'status');
    pill.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'left:50%', 'transform:translateX(-50%)',
      'bottom:calc(16px + env(safe-area-inset-bottom, 0px))', 'display:flex', 'align-items:center', 'gap:4px',
      'padding:4px 4px 4px 16px', 'border-radius:999px', 'font:500 15px/1.2 -apple-system,system-ui,sans-serif',
      'box-shadow:0 8px 28px rgba(0,0,0,.28)', 'max-width:calc(100vw - 32px)', 'white-space:nowrap',
      dark ? 'background:#1f2326;color:#f2f4f5;border:1px solid #3a4044' : 'background:#fff;color:#16191b;border:1px solid #d5d9dc',
    ].join(';');
    var text = document.createElement('span');
    text.textContent = 'New version available';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reload';
    btn.style.cssText = 'min-height:40px;padding:0 16px;margin-left:8px;border:0;border-radius:999px;font:600 15px -apple-system,system-ui,sans-serif;cursor:pointer;'
      + (dark ? 'background:#f2f4f5;color:#16191b' : 'background:#16191b;color:#fff');
    btn.addEventListener('click', reload);
    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Later');
    close.textContent = '×';
    close.style.cssText = 'width:40px;height:40px;border:0;background:none;color:inherit;font:22px/1 system-ui;cursor:pointer;opacity:.6';
    close.addEventListener('click', function () { pill.remove(); pill = null; });
    pill.append(text, btn, close);
    document.body.appendChild(pill);
  }

  function afterCheck(fromResume, awayMs) {
    check().then(function (changed) {
      if (!changed) return;
      if (fromResume && awayMs >= AWAY_FOR_QUIET_RELOAD && canReload() && !cfg().onUpdate) reload();
      else showPill();
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    var away = hiddenAt ? Date.now() - hiddenAt : 0;
    if (away > 2000) afterCheck(true, away);
  });
  window.addEventListener('pageshow', function (e) { if (e.persisted) afterCheck(true, AWAY_FOR_QUIET_RELOAD); });
  window.addEventListener('online', function () { afterCheck(false, 0); });
  setInterval(function () { if (!document.hidden) afterCheck(false, 0); }, CHECK_EVERY);

  function start() {
    // Baseline after the page has finished loading what it needs.
    setTimeout(function () { check(); }, 4000);
    if (SW && 'serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register(new URL(SW, base).href).catch(function () {});
    }
  }
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);

  window.__appUpdate = { check: check, reload: reload, get waiting() { return waiting; }, known: known };
})();
