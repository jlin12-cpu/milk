/**
 * cloud-sync.js v2 — Supabase 跨设备同步（安全版）
 *
 * 关键改进：不再是“打开就用云端覆盖本地”，而是按时间戳合并——
 *   - 每个键记录本地最后修改时间；
 *   - 拉云端时，只有“云端比本地更新”才覆盖本地，否则保留本地；
 *   - 本地比云端新（或云端没有）的键，自动推上去。
 * 因此刷新永远不会把你现有的数据清空。
 *
 * 同步码：手机和电脑填同一个即可。本项目统一用 jlin47（或你自定义的长码）。
 */
(function () {
  'use strict';

  /* ===== Supabase 配置（已填好） ===== */
  var SUPABASE_URL = 'https://cmvakkjftojjkiifhiqj.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_f2icS_s9Vvss1Q1MrM_sTg_g47g42oO';
  var TABLE = 'milk_sync';
  /* ================================= */

  var PREFIX = window.APP_PREFIX || 'CHAT_APP_V3_';
  var SYNC_CODE_KEY = 'MILK_SYNC_CODE';
  var META_KEY = 'MILK_SYNC_META';      // localStorage: { 键: ISO时间 } 本地各键最后修改时间

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

  /* ---------- 同步码 ---------- */
  function ensureSyncCode() {
    if (!syncCode) {
      var c = window.prompt('请输入「同步码」（手机和电脑填同一个，例如 jlin47）：', '');
      if (c) { syncCode = c.trim(); localStorage.setItem(SYNC_CODE_KEY, syncCode); }
    }
    return syncCode;
  }
  window.setSyncCode = function (c) { syncCode = (c || '').trim(); localStorage.setItem(SYNC_CODE_KEY, syncCode); location.reload(); };
  window.getSyncCode = function () { return syncCode; };

  /* ---------- 包装写入：记录本地时间 + 推送 ---------- */
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
      client.from(TABLE).upsert(
        { sync_code: syncCode, k: key, v: (value === undefined ? null : value), updated_at: ts },
        { onConflict: 'sync_code,k' }
      ).then(function (r) { if (r.error) console.warn('[cloud-sync] 推送失败', key, r.error.message); });
    }, 800);
  }

  async function pushKeys(keys) {
    var batch = [];
    for (var i = 0; i < keys.length; i++) {
      var v = await localforage.getItem(keys[i]);
      batch.push({ sync_code: syncCode, k: keys[i], v: (v == null ? null : v), updated_at: meta[keys[i]] || nowIso() });
    }
    for (var j = 0; j < batch.length; j += 40) {
      var r = await client.from(TABLE).upsert(batch.slice(j, j + 40), { onConflict: 'sync_code,k' });
      if (r.error) console.warn('[cloud-sync] 批量推送失败', r.error.message);
    }
  }

  /* ---------- 安全合并：谁新用谁，绝不用旧数据覆盖新数据 ---------- */
  async function syncMerge() {
    if (!syncCode) return;
    var localKeys = (await localforage.keys()).filter(syncable);

    // 升级后第一次：给没有时间戳的本地键标成“现在”，
    // 这样本地数据被视为最新——会被推上去，而不会被云端旧数据覆盖。
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
      var row = rows[r];
      cloudMap[row.k] = row.updated_at;
      var localTs = meta[row.k] || '';
      if (row.updated_at > localTs) {            // 仅当云端严格更新才覆盖本地
        try { await _setItem(row.k, row.v); } catch (e) {}
        meta[row.k] = row.updated_at;
      }
    }
    applyingRemote = false;
    saveMeta();

    // 本地比云端新（或云端没有）的键，补推上去
    var toPush = [];
    for (var x = 0; x < localKeys.length; x++) {
      var lk = localKeys[x], cTs = cloudMap[lk];
      if (!cTs || (meta[lk] && meta[lk] > cTs)) toPush.push(lk);
    }
    if (toPush.length) { try { await pushKeys(toPush); } catch (e) {} }
    console.log('[cloud-sync] 合并完成：云端 ' + rows.length + ' 项，本地补推 ' + toPush.length + ' 项');
  }
  window.cloudSyncMerge = syncMerge;

  // 强制把本机数据设为“最新”并全部推上云（用于指定某台为数据源）
  window.cloudSyncPushAll = async function () {
    var ks = (await localforage.keys()).filter(syncable);
    var t = nowIso();
    for (var i = 0; i < ks.length; i++) meta[ks[i]] = t;
    saveMeta();
    await pushKeys(ks);
    console.log('[cloud-sync] 已强制上传本地 ' + ks.length + ' 项');
  };

  /* ---------- 启动：合并（不再是覆盖） ---------- */
  if (typeof window.initializeSession === 'function') {
    var _origInit = window.initializeSession;
    window.initializeSession = async function () {
      ensureSyncCode();
      try { await syncMerge(); } catch (e) { console.warn('[cloud-sync] 合并异常', e); }
      return _origInit.apply(this, arguments);
    };
  }

  /* ---------- 切回页面：云端更新时弹提示（不强制刷新，避免打断你输入） ---------- */
  window.addEventListener('DOMContentLoaded', function () { setTimeout(function () { booted = true; }, 4000); });
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

})();