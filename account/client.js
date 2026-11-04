(function (root, factory) {
  'use strict'; var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.MagnetAccountClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  var RULESET = 'v0.5.1', MAX_PAYLOAD = 262144, REDIRECT = 'https://lazybones-89.github.io/magnet-breaker/';
  function fault(code) { var error = new Error(code); error.code = code; return error; }
  function need(ok, code) { if (!ok) throw fault(code); }
  function checked(response) { if (!response || response.error) throw fault('service_error'); return response.data; }
  function nickname(value) {
    value = String(value || '').trim();
    need(Array.from(value).length >= 2 && Array.from(value).length <= 12 && !/[\u0000-\u001f\u007f]/.test(value), 'nickname_required'); return value;
  }
  function envelope(text) {
    need(typeof text === 'string' && new TextEncoder().encode(text).length <= MAX_PAYLOAD, 'invalid_profile');
    var p; try { p = JSON.parse(text); } catch (_) { throw fault('invalid_profile'); }
    need(p && p.format === 'magnet-cloud-profile' && p.version === 1 && p.ruleset === RULESET &&
      ['progression', 'records', 'endless'].every(function (k) { return typeof p[k] === 'string'; }), 'invalid_profile');
    return { format: p.format, version: p.version, ruleset: p.ruleset, progression: p.progression, records: p.records, endless: p.endless };
  }
  function profile(text) { envelope(text); return text; }
  function same(a, b) { return !!a && !!b && ['format', 'version', 'ruleset', 'progression', 'records', 'endless'].every(function (k) { return a[k] === b[k]; }); }
  // Read-only comparison copy: quote large integer tokens before parsing. Never serialize this
  // copy into a save. Original inner JSON strings, including 60-bit masks, stay byte-for-byte intact.
  function comparisonObject(text) {
    if (text === '') return {};
    var safe = text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, function (token) {
      return token[0] !== '"' && /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? '"' + token + '"' : token;
    });
    var value; try { value = JSON.parse(safe); } catch (_) { throw fault('invalid_profile'); }
    need(value && typeof value === 'object' && !Array.isArray(value), 'invalid_profile'); return value;
  }
  function integer(value, max) {
    if (value === undefined) return 0n;
    need((typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' && /^\d+$/.test(value)) && BigInt(value) >= 0n, 'invalid_profile');
    var n = BigInt(value); if (max !== undefined) need(n <= BigInt(max), 'invalid_profile'); return n;
  }
  function progress(p) {
    var credits = comparisonObject(p.progression), records = comparisonObject(p.records), mask = integer(records.clearedStageMask, 1073741823);
    if (records.runs !== undefined) {
      need(Array.isArray(records.runs), 'invalid_profile');
      records.runs.forEach(function (run) { if (run && run.result === 'won') { var stage = integer(run.stageId, 29); mask |= 1n << stage; } });
    }
    var cleared = 0, highest = 0;
    for (var i = 0; i < 30; i++) if ((mask & (1n << BigInt(i))) !== 0n) { cleared++; highest = i + 1; }
    var upgrades = ['hullLevel', 'dashLevel', 'magnetLevel', 'capacityLevel', 'fireLevel'].reduce(function (n, k) { return n + Number(integer(credits[k], 3)); }, 0);
    return { cleared: cleared, highest: highest, upgrades: upgrades, totalEarned: integer(credits.totalEarned, '9223372036854775807').toString() };
  }
  function compare(local, cloud) {
    var a = progress(local), b = cloud ? progress(cloud) : null, identical = cloud ? same(local, cloud) : false, recommendation = 'upload';
    if (identical) recommendation = 'none';
    else if (b) {
      recommendation = 'choose';
      for (var key of ['cleared', 'highest', 'upgrades', 'totalEarned']) {
        var av = BigInt(a[key]), bv = BigInt(b[key]);
        if (av !== bv) { recommendation = av > bv ? 'upload' : 'download'; break; }
      }
    }
    return { identical: identical, recommendation: recommendation, local: a, cloud: b };
  }
  function result(text) {
    var p; try { p = typeof text === 'string' ? JSON.parse(text) : text; } catch (_) { throw fault('invalid_result'); }
    need(p && p.won === true && p.experimental === false && p.review === false && p.mode === 'campaign', 'ineligible_result');
    need(typeof p.runId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.runId), 'invalid_result');
    need((typeof p.score === 'string' && /^(0|[1-9][0-9]*)$/.test(p.score) || Number.isSafeInteger(p.score)) && Number(p.score) >= 0 && Number(p.score) <= 10000000, 'invalid_result');
    need(Number.isInteger(p.operation) && p.operation >= 1 && p.operation <= 30 && Number.isSafeInteger(p.elapsedMs) && p.elapsedMs >= 0 && p.elapsedMs <= 2147483647, 'invalid_result');
    need(typeof p.gameVersion === 'string' && /^[0-9][0-9A-Za-z._-]{0,31}$/.test(p.gameVersion), 'invalid_result'); return p;
  }
  function create(options) {
    var cfg = options.config || {}, sdk = null, session = null, epoch = 0, loginGeneration = 0, profileName = '', profileEpoch = -1, profileTask = null;
    var game = null, details = {}, gameState = {}, busy = false, restoring = false, conflict = false, remote = null, comparison = null;
    var lastError = '', scoreStatus = '', queuedVictories = [], waiting = new Map(), initialized = false;
    var timer = options.setTimeout || setTimeout, untimer = options.clearTimeout || clearTimeout, now = options.now || Date.now;
    var uuid = options.uuid || function () { return root.crypto.randomUUID(); }, enabled = cfg.enabled === true;
    var storage = options.storage; if (!storage) { try { storage = root.localStorage; } catch (_) {} }
    try { var u = new URL(cfg.url); enabled = enabled && u.protocol === 'https:' && !u.username && !u.password && !!cfg.publishableKey && cfg.redirectTo === REDIRECT; } catch (_) { enabled = false; }
    function state() {
      return { enabled: enabled, signedIn: !!session, nickname: profileName, sessionEpoch: epoch, loginGeneration: loginGeneration, profileLoading: !!session && profileEpoch !== epoch,
        ready: !!game, review: excluded(), busy: busy, conflict: conflict, restoring: restoring, retrySave: false,
        remote: remote && { found: remote.found, updatedAt: remote.updated_at }, comparison: comparison,
        scoreStatus: scoreStatus, lastError: lastError, canSync: gameState.canSync === true, canImport: gameState.canImport === true,
        localRevision: typeof gameState.localRevision === 'string' ? gameState.localRevision : '' };
    }
    function emit() { if (options.changed) options.changed(state()); }
    function excluded() { return !!(details.reviewBuild || details.reviewUnlocked || details.mode || gameState.review || gameState.experimental || gameState.qa); }
    function auth() { need(enabled && sdk, 'not_connected'); need(session && session.user && session.access_token, 'sign_in_required'); return { epoch: epoch, id: session.user.id, token: session.access_token }; }
    function current(c) { need(session && c.epoch === epoch && c.id === session.user.id, 'account_changed'); }
    function normal(sync, importing) {
      need(game, 'game_not_ready'); need(!excluded(), 'review_not_supported'); need(!restoring, 'reload_required');
      if (sync) need(gameState.canSync === true && gameState.durable === true, 'menu_required');
      if (importing) need(gameState.canImport === true, 'menu_required');
    }
    function applySession(next) {
      var old = session && session.user.id, id = next && next.user && next.user.id;
      if (old !== id) loginGeneration++;
      if (old !== id || (session && next && session.access_token !== next.access_token)) {
        epoch++; remote = comparison = null; conflict = false; queuedVictories = []; profileName = ''; profileEpoch = -1; profileTask = null; scoreStatus = '';
        waiting.forEach(function (item) { untimer(item.timer); item.reject(fault('account_changed')); }); waiting.clear();
      }
      session = id ? next : null; emit();
    }
    async function query(builder, c) {
      if (c) { current(c); builder = builder.setHeader('Authorization', 'Bearer ' + c.token); }
      var response; try { response = await builder; } catch (_) { if (c) current(c); throw fault('network_error'); }
      if (c) current(c); return response;
    }
    async function serial(work) {
      need(!busy, 'busy'); busy = true; lastError = ''; emit();
      try { return await work(); } catch (error) { lastError = error.code || 'service_error'; throw error; }
      finally { busy = false; emit(); drainVictory(); }
    }
    async function loadProfile(c, force) {
      if (profileEpoch === c.epoch && !force) return profileName;
      if (profileTask && profileTask.epoch === c.epoch) return profileTask.promise;
      var job = { epoch: c.epoch }; profileTask = job;
      job.promise = (async function () {
        try {
          var row = checked(await query(sdk.from('profiles').select('id,nickname').eq('id', c.id).maybeSingle(), c));
          if (row) { need(row.id === c.id, 'invalid_response'); profileName = nickname(row.nickname); } else profileName = '';
          profileEpoch = c.epoch; return profileName;
        } finally { if (profileTask === job) profileTask = null; emit(); drainVictory(); }
      })(); return job.promise;
    }
    function bridge(action, payload, expectedLocalRevision) {
      need(game, 'game_not_ready');
      // Pausing/reading UI state is safe in review; profile and score commands remain excluded.
      need(!excluded() || action === 'pause-for-account' || action === 'state', 'review_not_supported');
      return new Promise(function (resolve, reject) {
        var id = uuid(), timeout = timer(function () { waiting.delete(id); reject(fault('game_timeout')); }, 60000);
        waiting.set(id, { resolve: resolve, reject: reject, timer: timeout });
        try { game.SendMessage('Magnet Breaker Runtime', 'OnCloudCommand', JSON.stringify({ request: id, action: action, payload: payload || '', expectedLocalRevision: expectedLocalRevision || '' })); }
        catch (_) { untimer(timeout); waiting.delete(id); reject(fault('game_unavailable')); }
      });
    }
    async function readRemote(c) {
      var row = checked(await query(sdk.from('saves').select('user_id,data,updated_at').eq('user_id', c.id).maybeSingle(), c));
      if (!row) return { found: false, data: null, updated_at: null };
      need(row.user_id === c.id && typeof row.updated_at === 'string' && Number.isFinite(Date.parse(row.updated_at)), 'invalid_response');
      return { found: true, data: envelope(JSON.stringify(row.data)), updated_at: row.updated_at };
    }
    function unchanged(a, b) { return a.found === b.found && (!a.found || a.updated_at === b.updated_at && same(a.data, b.data)); }
    async function exportLocal(c) {
      normal(true, false); var reply = await bridge('export'); current(c);
      need(typeof reply.localRevision === 'string' && reply.localRevision.length > 0 && reply.localRevision.length <= 128, 'invalid_response');
      return { data: envelope(reply.payload), revision: reply.localRevision };
    }
    async function compareNow(c) {
      var exported = await exportLocal(c), local = exported.data;
      remote = await readRemote(c); comparison = compare(local, remote.data); conflict = false; emit();
      return { local: local, localRevision: exported.revision, remote: remote, comparison: comparison };
    }
    async function transfer(direction, confirm) {
      var c = auth(), snapshot = await compareNow(c);
      if (snapshot.comparison.identical) return { status: 'unchanged', comparison: snapshot.comparison };
      if (direction === 'recommended') direction = snapshot.comparison.recommendation;
      need(direction === 'upload' || direction === 'download', 'choose_direction');
      if (direction === 'download') need(snapshot.remote.found, 'no_cloud_save');
      need(typeof confirm === 'function' && await confirm({ direction: direction, comparison: snapshot.comparison }) === true, 'cancelled');
      current(c); normal(true, direction === 'download');
      var localNow = await exportLocal(c);
      need(same(snapshot.local, localNow.data) && snapshot.localRevision === localNow.revision, 'local_changed');
      var fresh = await readRemote(c);
      if (!unchanged(snapshot.remote, fresh)) { remote = fresh; conflict = true; throw fault('save_conflict'); }
      // The final server read can take time; re-export after it, then issue the action immediately.
      var finalLocal = await exportLocal(c);
      need(same(snapshot.local, finalLocal.data) && snapshot.localRevision === finalLocal.revision, 'local_changed');
      if (direction === 'download') {
        current(c); normal(true, true); restoring = true; emit();
        var reply;
        try { reply = await bridge('import', JSON.stringify(fresh.data), snapshot.localRevision); }
        catch (error) { if (error.code === 'operation_not_available' || error.code === 'game_unavailable' || error.code === 'local_changed') restoring = false; throw error; }
        current(c); need(reply.readyToReload === true, 'local_save_pending'); return { status: 'loaded', readyToReload: true };
      }
      current(c); normal(true, false);
      var timestamp = new Date(Math.max(now(), fresh.found ? Date.parse(fresh.updated_at) + 1 : 0)).toISOString();
      var builder = fresh.found ? sdk.from('saves').update({ data: snapshot.local, updated_at: timestamp }).eq('user_id', c.id)
        .eq('updated_at', fresh.updated_at) : sdk.from('saves').insert({ user_id: c.id, data: snapshot.local, updated_at: timestamp });
      var response;
      try { response = await query(builder.select('user_id,data,updated_at').maybeSingle(), c); }
      catch (error) { if (error.code === 'network_error') { conflict = true; throw fault('save_uncertain'); } throw error; }
      if (response && response.error && response.error.code === '23505' || response && !response.error && !response.data) { conflict = true; throw fault('save_conflict'); }
      checked(response);
      // A successful HTTP response does not prove another PC did not write immediately after it.
      remote = await readRemote(c);
      if (!remote.found || !same(remote.data, snapshot.local)) { conflict = true; throw fault('save_conflict'); }
      comparison = compare(snapshot.local, remote.data); conflict = false; return { status: 'saved', comparison: comparison, updatedAt: remote.updated_at };
    }
    async function googlePrepared() {
      var fetcher = options.fetch || root.fetch, controller = typeof AbortController !== 'undefined' ? new AbortController() : null, timeout;
      need(typeof fetcher === 'function', 'login_preparing');
      try {
        await Promise.race([
          (async function () {
            var response = await fetcher(cfg.url.replace(/\/$/, '') + '/auth/v1/settings', {
              method: 'GET', headers: { apikey: cfg.publishableKey }, signal: controller ? controller.signal : undefined, cache: 'no-store'
            });
            need(response && response.ok, 'login_preparing'); var settings = await response.json();
            need(settings && settings.external && settings.external.google === true, 'login_preparing');
          })(),
          new Promise(function (_, reject) { timeout = timer(function () { reject(fault('login_preparing')); }, 8000); })
        ]);
      } catch (_) { throw fault('login_preparing'); }
      finally { untimer(timeout); if (controller) controller.abort(); }
    }
    async function recoverPending(c) {
      if (!storage) return;
      var keys = [];
      try { for (var i = 0; i < storage.length; i++) { var key = storage.key(i); if (key && key.indexOf('magnet-account-score-v053:' + c.id + ':') === 0) keys.push(key); } }
      catch (_) { return; }
      for (var key of keys) {
        current(c); var entry = readLedger(key);
        if (!entry || (entry.status !== 'pending' && entry.status !== 'uncertain')) continue;
        try {
          await locked(key, function () { return reconcileScore(c, key, entry); }); scoreStatus = 'already_submitted';
        } catch (error) { if (error.code === 'account_changed') throw error; scoreStatus = 'score_uncertain'; }
      }
      emit();
    }
    function ledgerKey(c, run) { return 'magnet-account-score-v053:' + c.id + ':' + run; }
    function readLedger(key) { need(storage, 'score_storage_unavailable'); try { var raw = storage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (_) { throw fault('score_storage_unavailable'); } }
    function writeLedger(key, value) { need(storage, 'score_storage_unavailable'); try { storage.setItem(key, JSON.stringify(value)); } catch (_) { throw fault('score_storage_unavailable'); } }
    function locked(key, work) {
      if (options.withLock) return options.withLock(key, work);
      need(root.navigator && root.navigator.locks, 'score_lock_unavailable');
      return root.navigator.locks.request(key, { mode: 'exclusive', ifAvailable: true }, function (lock) { need(lock, 'busy'); return work(); });
    }
    async function reconcileScore(c, key, entry) {
      var row = entry.row;
      var matches = checked(await query(sdk.from('scores').select('id,stage,score,clear_time_sec,game_version,created_at').eq('user_id', c.id)
        .eq('stage', row.stage).eq('score', row.score).eq('clear_time_sec', row.clear_time_sec).eq('game_version', row.game_version)
        .gte('created_at', entry.since).limit(2), c));
      if (Array.isArray(matches) && matches.length > 0) { entry.status = 'accepted'; writeLedger(key, entry); return { status: 'already_submitted' }; }
      entry.status = 'uncertain'; writeLedger(key, entry); throw fault('score_uncertain');
    }
    async function submit(p, c) {
      current(c); normal(false, false); await loadProfile(c); current(c); need(profileName, 'nickname_required'); p = result(p);
      var key = ledgerKey(c, p.runId);
      return locked(key, async function () {
        current(c); var entry = readLedger(key);
        if (entry && entry.status === 'accepted') return { status: 'already_submitted' };
        if (entry && entry.status !== 'failed') return reconcileScore(c, key, entry);
        var row = { user_id: c.id, stage: p.operation, score: Number(p.score), clear_time_sec: p.elapsedMs / 1000, game_version: p.gameVersion };
        entry = { status: 'pending', row: row, since: new Date(now() - 5000).toISOString() }; writeLedger(key, entry);
        var response;
        try { response = await query(sdk.from('scores').insert(row), c); }
        catch (error) { entry.status = 'uncertain'; writeLedger(key, entry); throw error.code === 'account_changed' ? error : fault('score_uncertain'); }
        if (!response || response.error) { entry.status = 'failed'; writeLedger(key, entry); throw fault('score_rejected'); }
        current(c); entry.status = 'accepted'; writeLedger(key, entry); return { status: 'submitted' };
      });
    }
    function drainVictory() {
      if (!queuedVictories.length || busy || !session) return;
      var item = queuedVictories[0];
      if (item.context.epoch !== epoch) { queuedVictories.shift(); drainVictory(); return; }
      if (profileEpoch !== epoch) return;
      queuedVictories.shift();
      if (!profileName) { queuedVictories = []; scoreStatus = 'nickname_required'; emit(); return; }
      timer(function () {
        if (item.context.epoch !== epoch) return;
        if (busy) { queuedVictories.unshift(item); return; }
        serial(async function () {
          scoreStatus = 'submitting'; emit(); var reply = await submit(item.result, item.context); scoreStatus = reply.status; return reply;
        }).catch(function (error) { scoreStatus = error.code || 'service_error'; lastError = scoreStatus; emit(); });
      }, 0);
    }
    var api = {
      state: state,
      init: async function () {
        if (initialized || !enabled) { emit(); return; } initialized = true;
        sdk = options.createClient(cfg.url, cfg.publishableKey, { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
        sdk.auth.onAuthStateChange(function (_event, next) {
          // Keep callback synchronous and defer every SDK call until the callback returns.
          applySession(next);
          if (session) timer(function () { if (session) api.refreshProfile().then(function () { return recoverPending(auth()); }).catch(function (error) { lastError = error.code || 'service_error'; emit(); }); }, 0);
        });
        var before = epoch, initial = checked(await sdk.auth.getSession()); if (before === epoch) applySession(initial.session);
        if (session) { var context = auth(); await loadProfile(context); await recoverPending(context); }
        var page = new URL(options.pageUrl);
        if (page.searchParams.has('error') || new URLSearchParams(page.hash.replace(/^#/, '')).has('error')) lastError = 'login_preparing';
        emit();
      },
      attachGame: function (instance, readyDetails) { game = instance; details = readyDetails || {}; emit(); },
      receive: function (text) {
        var msg; try { msg = typeof text === 'string' ? JSON.parse(text) : text; } catch (_) { return; }
        if (!msg || !waiting.has(msg.request)) return;
        var item = waiting.get(msg.request); waiting.delete(msg.request); untimer(item.timer);
        if (msg.ok === true) item.resolve(msg); else item.reject(fault(msg.code || 'game_error'));
      },
      onGameState: function (value) { gameState = value || {}; if (excluded()) queuedVictories = []; emit(); },
      onVictory: function (value) {
        if (!session || excluded() || restoring) return;
        var p; try { p = result(value); } catch (_) { return; }
        if (profileEpoch === epoch && !profileName) { scoreStatus = 'nickname_required'; emit(); return; }
        if (!queuedVictories.some(function (item) { return item.result.runId === p.runId; })) queuedVictories.push({ result: p, context: auth() });
        drainVictory();
      },
      pauseForAccount: function () { return bridge('pause-for-account'); },
      signInWithGoogle: function () { return serial(async function () {
        need(sdk, 'not_connected'); var page = new URL(options.pageUrl);
        var canonical = new URL(REDIRECT);
        need(page.origin === canonical.origin && (page.pathname === canonical.pathname || page.pathname === canonical.pathname + 'index.html'), 'login_local_preview');
        await googlePrepared();
        var response;
        try { response = await sdk.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: REDIRECT, skipBrowserRedirect: true } }); }
        catch (_) { throw fault('login_preparing'); }
        if (!response || response.error || !response.data || !response.data.url) throw fault('login_preparing');
        var target = new URL(response.data.url), service = new URL(cfg.url);
        need(target.origin === service.origin && target.pathname === '/auth/v1/authorize' && target.searchParams.get('provider') === 'google', 'login_preparing');
        if (options.navigate) options.navigate(target.href); else root.location.assign(target.href);
      }); },
      signOut: function () { return serial(async function () { var c = auth(); var response = await sdk.auth.signOut({ scope: 'local' }); if (session && session.user.id !== c.id) throw fault('account_changed'); checked(response); applySession(null); }); },
      refreshProfile: function () { var c = auth(); return loadProfile(c, true); },
      setNickname: function (name) { return serial(async function () {
        var c = auth(); name = nickname(name); await loadProfile(c); current(c); need(!profileName, 'nickname_already_set');
        var response = await query(sdk.from('profiles').insert({ id: c.id, nickname: name }).select('id,nickname').maybeSingle(), c);
        if (response && response.error && response.error.code === '23505') { profileEpoch = -1; await loadProfile(c); throw fault(profileName ? 'nickname_already_set' : 'nickname_taken'); }
        var row = checked(response); need(row && row.id === c.id && row.nickname === name, 'invalid_response'); profileName = name; profileEpoch = c.epoch; emit();
      }); },
      compareCloud: function () { return serial(async function () { return (await compareNow(auth())).comparison; }); },
      refreshCloud: function () { return api.compareCloud(); },
      saveCloud: function (confirm) { return serial(function () { return transfer('upload', confirm); }); },
      loadCloud: function (confirm) { return serial(function () { return transfer('download', confirm); }); },
      syncCloud: function (confirm) { return serial(function () { return transfer('recommended', confirm); }); },
      restoreStatus: function () { return serial(async function () { var c = auth(); need(restoring, 'no_restore'); var reply = await bridge('restore-status'); current(c); need(reply.readyToReload === true, 'local_save_pending'); return { readyToReload: true }; }); },
      submitResult: function () { return serial(async function () {
        var c = auth(); var reply = await bridge('result'); current(c); var p = result(reply.payload), entry = readLedger(ledgerKey(c, p.runId));
        // No manual/late-login submission of a guest victory. This path only reconciles a known attempt.
        need(entry, 'ineligible_result'); return submit(p, c);
      }); },
      leaderboard: function (stage) { return serial(async function () {
        need(sdk, 'not_connected'); need(Number.isInteger(stage) && stage >= 1 && stage <= 30, 'invalid_operation');
        var rows = checked(await query(sdk.from('leaderboard').select('stage,nickname,best_score,best_time').eq('stage', stage).order('best_score', { ascending: false }).limit(50)));
        need(Array.isArray(rows) && rows.length <= 50, 'invalid_response');
        rows.forEach(function (row) { need(row.stage === stage && typeof row.nickname === 'string' && Number.isFinite(Number(row.best_score)) && Number(row.best_score) >= 0 && Number(row.best_score) <= 10000000, 'invalid_response'); }); return rows;
      }); }
    };
    return api;
  }
  return { create: create, profile: profile, result: result, nickname: nickname, progress: function (text) { return progress(envelope(text)); }, compare: function (a, b) { return compare(envelope(a), b ? envelope(b) : null); } };
});
