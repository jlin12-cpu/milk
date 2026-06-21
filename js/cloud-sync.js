/**
 * cloud-sync.js — Supabase 跨设备同步层（同步码方案，无需账号）
 *
 * 原理：把 localforage 里所有以 APP_PREFIX 开头的键，镜像到 Supabase 的一张表里。
 *   - 打开页面      → 先从云端拉取覆盖本地，再走原本的初始化流程
 *   - 本地任何写入  → 防抖后自动推送到云端
 *   - 切回标签页    → 若云端有更新则自动刷新页面
 *   - （可选）实时   → 另一台设备改动时弹出“点击刷新”提示
 *
 * 手机和电脑填同一个「同步码」即可共享同一份数据。
 *
 * 加载位置：必须在 supabase SDK 和 js/core.js 之后加载（见说明）。
 */
(function () {
  'use strict';

  /* ===== 1) 在这里填入你自己的 Supabase 配置 ===== */
  var SUPABASE_URL = 'https://cmvakkjftojjkiifhiqj.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_f2icS_s9Vvss1Q1MrM_sTg_g47g42oO';
  var TABLE = 'milk_sync';
  /* ============================================== */

  var PREFIX = window.APP_PREFIX || 'CHAT_APP_V3_';
  var SYNC_CODE_KEY = 'MILK_SYNC_CODE';

  // 没配置 / SDK 没加载 → 保持纯本地模式，不影响原功能
  if (SUPABASE_URL.indexOf('YOUR-PROJECT') !== -1 || !window.supabase) {
    console.warn('[cloud-sync] 未配置 Supabase 或 SDK 未加载，使用纯本地模式');
    return;
  }

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var syncCode = (localStorage.getItem(SYNC_CODE_KEY) || '').trim();
  var applyingRemote = false;   // 拉取写入时为 true，避免又触发推送（防回环）
  var pushTimers = {};          // 每个键独立防抖
  var lastRemoteTs = '';        // 已应用过的云端最新时间戳（ISO 字符串，可直接字典序比较）
  var booted = false;

  /* ---------- 同步码 ---------- */
  function ensureSyncCode() {
    if (!syncCode) {
      var c = window.prompt('请输入「同步码」（手机和电脑请填同一个，例如：milk-jlin-2026）：', '');
      if (c) { syncCode = c.trim(); localStorage.setItem(SYNC_CODE_KEY, syncCode); }
    }
    return syncCode;
  }
  window.setSyncCode = function (c) {            // 控制台改同步码：setSyncCode('新码')
    syncCode = (c || '').trim();
    localStorage.setItem(SYNC_CODE_KEY, syncCode);
    location.reload();
  };
  window.getSyncCode = function () { return syncCode; };

  /* ---------- 包装 localforage 写入：自动推送 ---------- */
  var _setItem = localforage.setItem.bind(localforage);
  var _removeItem = localforage.removeItem.bind(localforage);

  localforage.setItem = function (key, value, cb) {
    var p = _setItem(key, value, cb);
    if (!applyingRemote && typeof key === 'string' && key.indexOf(PREFIX) === 0 && syncCode) {
      schedulePush(key, value);
    }
    return p;
  };
  localforage.removeItem = function (key, cb) {
    var p = _removeItem(key, cb);
    if (!applyingRemote && typeof key === 'string' && key.indexOf(PREFIX) === 0 && syncCode) {
      client.from(TABLE).delete().eq('sync_code', syncCode).eq('k', key).then(function (r) {
        if (r.error) console.warn('[cloud-sync] 删除失败', key, r.error.message);
      });
    }
    return p;
  };

  function schedulePush(key, value) {
    clearTimeout(pushTimers[key]);
    pushTimers[key] = setTimeout(function () {
      var ts = new Date().toISOString();
      client.from(TABLE).upsert(
        { sync_code: syncCode, k: key, v: (value === undefined ? null : value), updated_at: ts },
        { onConflict: 'sync_code,k' }
      ).then(function (r) {
        if (r.error) console.warn('[cloud-sync] 推送失败', key, r.error.message);
        else if (ts > lastRemoteTs) lastRemoteTs = ts;  // 自己推的不要再触发刷新
      });
    }, 1200);
  }

  /* ---------- 从云端拉取覆盖本地 ---------- */
  async function pull() {
    if (!syncCode) return -1;
    try {
      var res = await client.from(TABLE).select('k,v,updated_at').eq('sync_code', syncCode);
      if (res.error) { console.warn('[cloud-sync] 拉取失败', res.error.message); return -1; }
      var rows = res.data || [];
      applyingRemote = true;
      for (var i = 0; i < rows.length; i++) {
        try { await _setItem(rows[i].k, rows[i].v); } catch (e) {}
        if (rows[i].updated_at && rows[i].updated_at > lastRemoteTs) lastRemoteTs = rows[i].updated_at;
      }
      applyingRemote = false;
      console.log('[cloud-sync] 已从云端同步 ' + rows.length + ' 项');
      return rows.length;
    } catch (e) {
      applyingRemote = false;
      console.warn('[cloud-sync] 拉取异常', e);
      return -1;
    }
  }
  window.cloudSyncPull = pull;

  /* ---------- 把本设备全部数据上传到云端（首次/强制用） ---------- */
  async function pushAll() {
    if (!syncCode) return;
    var keys = await localforage.keys();
    var batch = [], ts = new Date().toISOString();
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(PREFIX) !== 0) continue;
      var v = await localforage.getItem(keys[i]);
      batch.push({ sync_code: syncCode, k: keys[i], v: (v == null ? null : v), updated_at: ts });
    }
    if (!batch.length) return;
    for (var j = 0; j < batch.length; j += 50) {       // 分批，避免单次过大
      var r = await client.from(TABLE).upsert(batch.slice(j, j + 50), { onConflict: 'sync_code,k' });
      if (r.error) console.warn('[cloud-sync] 批量上传失败', r.error.message);
    }
    if (ts > lastRemoteTs) lastRemoteTs = ts;
    console.log('[cloud-sync] 已上传本地 ' + batch.length + ' 项到云端');
  }
  window.cloudSyncPushAll = pushAll;   // 控制台手动把本机设为“数据源”：cloudSyncPushAll()

  /* ---------- 接管启动：先拉取，再走原本的 initializeSession ---------- */
  if (typeof window.initializeSession === 'function') {
    var _origInit = window.initializeSession;
    window.initializeSession = async function () {
      ensureSyncCode();
      var n = await pull();                       // 先从云端拉
      var ret = await _origInit.apply(this, arguments);
      if (n === 0) { try { await pushAll(); } catch (e) {} }  // 云端是空的 → 把本机数据传上去
      return ret;
    };
  }

  /* ---------- 切回页面时：云端有更新就自动刷新 ---------- */
  window.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () { booted = true; }, 4000);
  });
  document.addEventListener('visibilitychange', async function () {
    if (document.visibilityState !== 'visible' || !booted || !syncCode) return;
    try {
      var res = await client.from(TABLE).select('updated_at')
        .eq('sync_code', syncCode).order('updated_at', { ascending: false }).limit(1);
      if (res.error) return;
      var top = res.data && res.data[0] && res.data[0].updated_at;
      if (top && top > lastRemoteTs) { await pull(); location.reload(); }
    } catch (e) {}
  });

  /* ---------- 可选：实时订阅，另一台设备改了就弹提示 ---------- */
  try {
    client.channel('milk-sync-' + syncCode)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: TABLE, filter: 'sync_code=eq.' + syncCode },
        function (payload) {
          var ts = payload && payload['new'] && payload['new'].updated_at;
          if (booted && document.visibilityState === 'visible' && ts && ts > lastRemoteTs) showSyncToast();
        })
      .subscribe();
  } catch (e) {}

  function showSyncToast() {
    if (document.getElementById('cloud-sync-toast')) return;
    var t = document.createElement('div');
    t.id = 'cloud-sync-toast';
    t.textContent = '另一台设备有更新，点击刷新';
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;'
      + 'background:rgba(0,0,0,.82);color:#fff;padding:10px 18px;border-radius:20px;font-size:14px;'
      + 'cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    t.onclick = async function () { await pull(); location.reload(); };
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 8000);
  }

})();