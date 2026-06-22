/**
 * cloud-sync.js v3 — Supabase 跨设备同步（安全版 + 可见同步按钮）
 *
 * 在 v2「按时间戳合并、绝不用旧数据覆盖新数据」基础上，新增：
 *   - 右下角一个「☁」按钮：点一下强制把本机数据上传，结果（成功条数/错误）直接显示在屏幕上；
 *   - 页面切到后台时，立即把待上传的改动推一次（尽量避免手机锁屏掐断）；
 *   - 上传失败会弹出可见提示，方便排查。
 */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://cmvakkjftojjkiifhiqj.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_f2icS_s9Vvss1Q1MrM_sTg_g47g42oO';
  var TABLE = 'milk_sync';

  var PREFIX = window.APP_PREFIX || 'CHAT_APP_V3_';
  var SYNC_CODE_KEY = 'MILK_SYNC_CODE';
  var META_KEY = 'MILK_SYNC_META';

  if (SUPABASE_URL.indexOf('YOUR-PROJECT') !== -1 || !window.supabase) {
    console.warn('[cloud-sync] 未配置或 SDK 未加载，纯本地模式'); return;
  }

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var syncCode = (localStorage.getItem(SYNC_CODE_KEY) || '').trim();
  var meta = {};
  try { meta = JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch (e) { meta = {}; }
  var applyingRemote = false;
  var pushTimers = {};
  var booted = false;

  function saveMeta() { try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) {} }
  function nowIso() { return new Date().toISOString(); }
  function syncable(k) { return typeof k === 'string' && k.indexOf(PREFIX) === 0; }

  function ensureSyncCode() {
    if (!syncCode) {
      var c = window.prompt('请输入「同步码」（手机和电脑填同一个，例如 jlin47）：', '');
      if (c) { syncCode = c.trim(); localStorage.setItem(SYNC_CODE_KEY, syncCode); }
    }
    return syncCode;
  }
  window.setSyncCode = function (c) { syncCode = (c || '').trim(); localStorage.setItem(SYNC_CODE_KEY, syncCode); location.reload(); };
  window.getSyncCode = function () { return syncCode; };

  var _setItem = localforage.setItem.bind(localforage);
  var _removeItem = localforage.removeItem.bind(localforage);

  localforage.setItem = function (key, value, cb) {
    var p = _setItem(key, value, cb);
    if (!applyingRemote && syncable(key) && syncCode) {
      var ts = nowIso();
      meta[key] = ts; saveMeta();
      schedulePush(key, value, ts);
    }
    return p;
  };
  localforage.removeItem = function (key, cb) {
    var p = _removeItem(key, cb);
    if (!applyingRemote && syncable(key) && syncCode) {
      delete meta[key]; saveMeta();
      client.from(TABLE).delete().eq('sync_code', syncCode).eq('k', key).then(function (r) {
        if (r.error) console.warn('[cloud-sync] 删除失败', key, r.error.message);
      });
    }
    return p;
  };

  function schedulePush(key, value, ts) {
    clearTimeout(pushTimers[key]);
    pushTimers[key] = setTimeout(function () {
      doUpsert(key, value, ts);
    }, 800);
  }
  function doUpsert(key, value, ts) {
    return client.from(TABLE).upsert(
      { sync_code: syncCode, k: key, v: (value === undefined ? null : value), updated_at: ts },
      { onConflict: 'sync_code,k' }
    ).then(function (r) {
      if (r.error) { console.warn('[cloud-sync] 推送失败', key, r.error.message); showResultToast('上传失败：' + r.error.message); }
    });
  }

  async function pull() {
    if (!syncCode) return;
    var localKeys = (await localforage.keys()).filter(syncable);
    var changed = false;
    for (var i = 0; i < localKeys.length; i++) {
      if (!meta[localKeys[i]]) { meta[localKeys[i]] = nowIso(); changed = true; }
    }
    if (changed) saveMeta();

    var res = await client.from(TABLE).select('k,v,updated_at').eq('sync_code', syncCode);
    if (res.error) { console.warn('[cloud-sync] 拉取失败', res.error.message); return; }
    var rows = res.data || [];
    var cloudMap = {};
    applyingRemote = true;
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r]; cloudMap[row.k] = row.updated_at;
      var localTs = meta[row.k] || '';
      if (row.updated_at > localTs) {
        try { await _setItem(row.k, row.v); } catch (e) {}
        meta[row.k] = row.updated_at;
      }
    }
    applyingRemote = false;
    saveMeta();

    var toPush = [];
    for (var x = 0; x < localKeys.length; x++) {
      var lk = localKeys[x], cTs = cloudMap[lk];
      if (!cTs || (meta[lk] && meta[lk] > cTs)) toPush.push(lk);
    }
    if (toPush.length) { try { await pushKeys(toPush); } catch (e) {} }
    console.log('[cloud-sync] 合并完成：云端 ' + rows.length + ' 项，本地补推 ' + toPush.length + ' 项');
  }
  window.cloudSyncMerge = pull;

  async function pushKeys(keys, forceTs) {
    var batch = [];
    for (var i = 0; i < keys.length; i++) {
      var v = await localforage.getItem(keys[i]);
      batch.push({ sync_code: syncCode, k: keys[i], v: (v == null ? null : v), updated_at: forceTs || meta[keys[i]] || nowIso() });
    }
    var failed = 0, firstErr = '';
    for (var j = 0; j < batch.length; j += 40) {
      var r = await client.from(TABLE).upsert(batch.slice(j, j + 40), { onConflict: 'sync_code,k' });
      if (r.error) { failed++; if (!firstErr) firstErr = r.error.message; }
    }
    return { count: batch.length, failed: failed, firstErr: firstErr };
  }

  // 强制把本机所有数据上传（手动按钮用），返回可显示的结果文字
  async function forcePushVisible() {
    if (!syncCode) return '没有同步码，无法上传（请先设置 jlin47）';
    try {
      var ks = (await localforage.keys()).filter(syncable);
      if (!ks.length) return '本机没有可上传的数据';
      var t = nowIso();
      for (var i = 0; i < ks.length; i++) meta[ks[i]] = t;
      saveMeta();
      var r = await pushKeys(ks, t);
      if (r.failed) return '上传失败：' + r.firstErr;
      return '已上传 ' + r.count + ' 项 ✅ 去另一台刷新即可';
    } catch (e) { return '上传出错：' + (e && e.message ? e.message : e); }
  }
  window.cloudSyncPushAll = forcePushVisible;

  if (typeof window.initializeSession === 'function') {
    var _origInit = window.initializeSession;
    window.initializeSession = async function () {
      ensureSyncCode();
      try { await pull(); } catch (e) { console.warn('[cloud-sync] 合并异常', e); }
      return _origInit.apply(this, arguments);
    };
  }

  // 切到后台：立刻把待发送的改动推一次（尽量别被手机锁屏掐断）
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      for (var k in pushTimers) { clearTimeout(pushTimers[k]); }
      if (syncCode) { try { forcePushVisible(); } catch (e) {} }
    }
  });

  // 切回前台：若云端更新则提示
  window.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () { booted = true; }, 4000);
    injectSyncButton();
  });
  document.addEventListener('visibilitychange', async function () {
    if (document.visibilityState !== 'visible' || !booted || !syncCode) return;
    try {
      var res = await client.from(TABLE).select('updated_at').eq('sync_code', syncCode)
        .order('updated_at', { ascending: false }).limit(1);
      if (res.error) return;
      var top = res.data && res.data[0] && res.data[0].updated_at;
      var maxLocal = '';
      for (var k in meta) { if (meta[k] > maxLocal) maxLocal = meta[k]; }
      if (top && top > maxLocal) showSyncToast();
    } catch (e) {}
  });

  function injectSyncButton() {
    if (document.getElementById('cloud-sync-btn')) return;
    var b = document.createElement('div');
    b.id = 'cloud-sync-btn';
    b.textContent = '☁';
    b.title = '立即同步上传';
    b.style.cssText = 'position:fixed;right:14px;bottom:96px;z-index:99998;width:44px;height:44px;'
      + 'border-radius:50%;background:rgba(180,150,90,.92);color:#fff;font-size:20px;display:flex;'
      + 'align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(0,0,0,.3);cursor:pointer;'
      + '-webkit-user-select:none;user-select:none;';
    b.onclick = async function () {
      b.textContent = '⏳';
      var msg = await forcePushVisible();
      b.textContent = '☁';
      showResultToast(msg);
    };
    document.body.appendChild(b);
  }

  function showSyncToast() {
    if (document.getElementById('cloud-sync-toast')) return;
    var t = document.createElement('div');
    t.id = 'cloud-sync-toast';
    t.textContent = '另一台设备有更新，点此同步';
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;'
      + 'background:rgba(0,0,0,.82);color:#fff;padding:10px 18px;border-radius:20px;font-size:14px;'
      + 'cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    t.onclick = function () { location.reload(); };
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 10000);
  }

  function showResultToast(msg) {
    var old = document.getElementById('cloud-sync-result');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var t = document.createElement('div');
    t.id = 'cloud-sync-result';
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:150px;transform:translateX(-50%);z-index:100000;'
      + 'max-width:80%;text-align:center;background:rgba(0,0,0,.88);color:#fff;padding:12px 18px;'
      + 'border-radius:14px;font-size:14px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.35)';
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 6000);
  }

})();