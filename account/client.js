(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MagnetAccountClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var RULESET = 'v0.5.1', MAX_PAYLOAD = 262144;
  function fault(code) { var e = new Error(code); e.code = code; return e; }
  function requireThat(ok, code) { if (!ok) throw fault(code); }
  function checked(response) { if (!response || response.error) throw fault('service_error'); return response.data; }
  function revision(value) { requireThat(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'invalid_response'); return value; }
  function profile(text) {
    requireThat(typeof text === 'string' && new TextEncoder().encode(text).length <= MAX_PAYLOAD, 'invalid_profile');
    var p; try { p = JSON.parse(text); } catch (_) { throw fault('invalid_profile'); }
    requireThat(p && p.format === 'magnet-cloud-profile' && p.version === 1 && p.ruleset === RULESET &&
      ['progression', 'records', 'endless'].every(function (key) { return typeof p[key] === 'string'; }), 'invalid_profile');
    // Deliberately never parse or reserialize the three inner JSON strings (60-bit masks).
    return text;
  }
  function nickname(value) { value = String(value || '').trim(); requireThat(Array.from(value).length >= 1 && Array.from(value).length <= 24 && !/[\u0000-\u001f\u007f]/.test(value), 'nickname_required'); return value; }
  function result(text) {
    var p; try { p = JSON.parse(text); } catch (_) { throw fault('invalid_result'); }
    requireThat(p && p.experimental === false && p.review === false, 'ineligible_result');
    requireThat(typeof p.runId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.runId), 'invalid_result');
    requireThat(typeof p.score === 'string' && /^(0|[1-9][0-9]*)$/.test(p.score) &&
      (p.score.length < 19 || (p.score.length === 19 && p.score <= '9223372036854775807')), 'invalid_result');
    requireThat(['elapsedMs', 'kills', 'wave', 'operation'].every(function (key) { return Number.isSafeInteger(p[key]) && p[key] >= 0 && p[key] <= 2147483647; }), 'invalid_result');
    requireThat((p.mode === 'campaign' && p.operation >= 1 && p.operation <= 30) || (p.mode === 'endless' && p.operation === 0), 'invalid_result');
    return p;
  }
  function create(options) {
    var cfg = options.config || {}, client = null, session = null, game = null, details = null;
    var epoch = 0, remote = null, pendingSave = null, conflict = false, busy = false, recovery = false, restoring = false;
    var waiting = new Map(), timer = options.setTimeout || setTimeout, untimer = options.clearTimeout || clearTimeout;
    var uuid = options.uuid || function () { return globalThis.crypto.randomUUID(); };
    var enabled = cfg.enabled === true;
    if (enabled) {
      var url; try { url = new URL(cfg.url); } catch (_) { enabled = false; }
      enabled = enabled && url.protocol === 'https:' && !url.username && !url.password && !!cfg.publishableKey;
    }
    function state() {
      return { enabled: enabled, signedIn: !!session, email: session ? session.user.email || '' : '',
        nickname: session ? session.user.user_metadata && session.user.user_metadata.display_name || '' : '',
        ready: !!game, review: !!(details && (details.reviewBuild || details.reviewUnlocked || details.mode)),
        busy: busy, recovery: recovery, remote: remote && { found: remote.found, updatedAt: remote.updated_at },
        retrySave: !!pendingSave && !conflict, conflict: conflict, restoring: restoring };
    }
    function emit() { if (options.changed) options.changed(state()); }
    function applySession(next) {
      var oldId = session && session.user.id, nextId = next && next.user && next.user.id;
      if (oldId !== nextId) { epoch++; remote = null; pendingSave = null; conflict = false; recovery = false; }
      session = nextId ? next : null; emit();
    }
    function authenticated() { requireThat(enabled && client, 'not_connected'); requireThat(session, 'sign_in_required'); return epoch; }
    function current(expected) { requireThat(expected === epoch && session, 'account_changed'); }
    function normalGame() { requireThat(game && details, 'game_not_ready'); requireThat(!details.reviewBuild && !details.reviewUnlocked && !details.mode, 'review_not_supported'); }
    async function serial(work) {
      requireThat(!busy, 'busy'); busy = true; emit();
      try { return await work(); } finally { busy = false; emit(); }
    }
    function rpc(name, args) {
      var request = client.rpc(name, args);
      // Pin this operation to the session that authorized it. A cross-tab auth
      // change while the SDK awaits fetch must not redirect old data to a new user.
      if (session) request = request.setHeader('Authorization', 'Bearer ' + session.access_token);
      return request.then(checked);
    }
    function slot() { return { p_slot: 'main', p_ruleset: RULESET, p_experimental: false }; }
    function returnUrl() { var u = new URL(options.pageUrl); requireThat(u.protocol === 'https:' || u.protocol === 'http:', 'invalid_return_url'); return u.origin + u.pathname; }
    function bridge(action, payload) {
      normalGame();
      return new Promise(function (resolve, reject) {
        var request = uuid();
        var timeout = timer(function () { waiting.delete(request); reject(fault('game_timeout')); }, 60000);
        waiting.set(request, { resolve: resolve, reject: reject, timer: timeout });
        try { game.SendMessage('Magnet Breaker Runtime', 'OnCloudCommand', JSON.stringify({ request: request, action: action, payload: payload || '' })); }
        catch (_) { untimer(timeout); waiting.delete(request); reject(fault('game_unavailable')); }
      });
    }
    async function getRemote(expected) {
      var value = await rpc('mb_save_get', slot()); current(expected);
      requireThat(value && typeof value.found === 'boolean', 'invalid_response'); revision(value.revision);
      if (value.found) profile(value.payload);
      remote = value; return value;
    }
    async function sendPending(expected) {
      var frozen = pendingSave;
      var value = await rpc('mb_save_put', frozen); current(expected);
      requireThat(value && (value.status === 'saved' || value.status === 'conflict'), 'invalid_response'); revision(value.revision);
      if (value.status === 'conflict') { conflict = true; throw fault('save_conflict'); }
      remote = { found: true, revision: value.revision, updated_at: value.updated_at, payload: frozen.p_payload };
      pendingSave = null; conflict = false; return value;
    }
    var api = {
      state: state,
      init: async function () {
        if (!enabled) { emit(); return; }
        client = options.createClient(cfg.url, cfg.publishableKey);
        client.auth.onAuthStateChange(function (event, next) {
          // Supabase auth callbacks stay synchronous; no nested awaited SDK call.
          applySession(next); if (event === 'PASSWORD_RECOVERY') { recovery = true; emit(); }
        });
        var startEpoch = epoch, initial = checked(await client.auth.getSession());
        if (epoch === startEpoch) applySession(initial.session);
      },
      attachGame: function (instance, readyDetails) { game = instance; details = readyDetails || {}; emit(); },
      receive: function (text) {
        var msg; try { msg = JSON.parse(text); } catch (_) { return; }
        if (!msg || typeof msg.request !== 'string' || !waiting.has(msg.request)) return;
        var item = waiting.get(msg.request); waiting.delete(msg.request); untimer(item.timer);
        if (msg.ok === true) item.resolve(msg); else item.reject(fault(msg.code || 'game_error'));
      },
      signUp: function (email, password) { return serial(async function () {
        requireThat(client, 'not_connected'); checked(await client.auth.signUp({ email: email, password: password, options: { emailRedirectTo: returnUrl() } }));
      }); },
      signIn: function (email, password) { return serial(async function () {
        requireThat(client, 'not_connected'); var response = checked(await client.auth.signInWithPassword({ email: email, password: password })); applySession(response.session);
      }); },
      signOut: function () { return serial(async function () { requireThat(client, 'not_connected'); checked(await client.auth.signOut({ scope: 'local' })); applySession(null); }); },
      resetPassword: function (email) { return serial(async function () {
        requireThat(client, 'not_connected'); checked(await client.auth.resetPasswordForEmail(email, { redirectTo: returnUrl() }));
      }); },
      changePassword: function (password) { return serial(async function () {
        authenticated(); requireThat(recovery, 'recovery_required'); checked(await client.auth.updateUser({ password: password })); recovery = false;
      }); },
      setNickname: function (name) { return serial(async function () {
        var e = authenticated(); name = nickname(name); var data = checked(await client.auth.updateUser({ data: { display_name: name } })); current(e);
        if (data.user) session = Object.assign({}, session, { user: data.user });
      }); },
      refreshCloud: function () { return serial(async function () {
        var e = authenticated(); var value = await getRemote(e); pendingSave = null; conflict = false; return { found: value.found, updatedAt: value.updated_at };
      }); },
      saveCloud: function (confirmOverwrite) { return serial(async function () {
        var e = authenticated(); normalGame(); requireThat(!restoring, 'reload_required');
        requireThat(!pendingSave, conflict ? 'save_conflict' : 'retry_pending');
        if (!remote) await getRemote(e);
        if (remote.found) requireThat(await confirmOverwrite(), 'cancelled'); current(e);
        var exported = await bridge('export'); current(e); profile(exported.payload);
        pendingSave = Object.assign(slot(), { p_expected_revision: remote.revision, p_payload: exported.payload, p_schema_version: 1, p_request_id: uuid() });
        return sendPending(e);
      }); },
      retrySave: function () { return serial(async function () {
        var e = authenticated(); requireThat(pendingSave && !conflict, 'no_retry'); normalGame(); return sendPending(e);
      }); },
      loadCloud: function (confirmImport) { return serial(async function () {
        var e = authenticated(); normalGame(); requireThat(!restoring, 'reload_required');
        var value = await getRemote(e); requireThat(value.found, 'no_cloud_save');
        requireThat(await confirmImport(), 'cancelled'); current(e);
        restoring = true; emit(); var reply;
        try { reply = await bridge('import', value.payload); }
        catch (error) { if (error.code === 'operation_not_available' || error.code === 'game_unavailable') restoring = false; throw error; }
        current(e);
        requireThat(reply.readyToReload === true, 'local_save_pending'); return { readyToReload: true };
      }); },
      restoreStatus: function () { return serial(async function () {
        authenticated(); requireThat(restoring, 'no_restore'); var reply = await bridge('restore-status');
        requireThat(reply.readyToReload === true, 'local_save_pending'); return { readyToReload: true };
      }); },
      submitResult: function (name) { return serial(async function () {
        var e = authenticated(); normalGame(); name = nickname(name);
        var response = await bridge('result'); current(e); var p = result(response.payload);
        var data = await rpc('mb_record_submit', { p_run_id: p.runId, p_ruleset: RULESET, p_mode: p.mode, p_operation: p.operation,
          p_score: p.score, p_elapsed_ms: p.elapsedMs, p_kills: p.kills, p_wave: p.wave,
          p_experimental: false, p_review: false, p_display_name: name }); current(e);
        requireThat(data && data.status === 'accepted' && data.eligible === true, 'invalid_response'); return data;
      }); },
      leaderboard: function (mode, operation) { return serial(async function () {
        requireThat(client, 'not_connected'); requireThat((mode === 'campaign' && Number.isInteger(operation) && operation >= 1 && operation <= 30) || (mode === 'endless' && operation === 0), 'invalid_operation');
        var rows = await rpc('mb_leaderboard', { p_ruleset: RULESET, p_mode: mode, p_operation: operation, p_limit: 30 });
        requireThat(Array.isArray(rows), 'invalid_response'); return rows;
      }); },
      deleteAccount: function (confirmDelete) { return serial(async function () {
        var e = authenticated(); requireThat(await confirmDelete(), 'cancelled'); current(e);
        var response = checked(await client.functions.invoke('delete-account', {
          body: { confirm: true }, headers: { Authorization: 'Bearer ' + session.access_token }
        })); current(e);
        requireThat(response && response.deleted === true, 'invalid_response');
        try { await client.auth.signOut({ scope: 'local' }); } finally { applySession(null); }
      }); }
    };
    return api;
  }
  return { create: create, profile: profile, result: result, nickname: nickname };
});
