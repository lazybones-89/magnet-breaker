(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var dialog = $('account-dialog'), status = $('account-status'), latest = null, view = 'account';
  var pendingConfirmation = null, returnFocus = null, rankRequest = 0;
  var comparedStates = new Set(), queuedComparison = null;
  var nicknamePrompts = new Set(), queuedNickname = null;
  var callbackFailed = false;
  try {
    var callbackUrl = new URL(location.href), callbackHash = new URLSearchParams(callbackUrl.hash.slice(1));
    callbackFailed = callbackUrl.searchParams.has('error') || callbackUrl.searchParams.has('error_description') || callbackHash.has('error') || callbackHash.has('error_description');
  } catch (_) {}
  var messages = {
    not_connected: '로그인 준비 중', login_preparing: '로그인 준비 중', login_local_preview: '로그인 준비 중',
    sign_in_required: '먼저 Google로 로그인해 주세요.',
    game_not_ready: '게임을 불러온 뒤 다시 시도해 주세요.', game_unavailable: '게임을 불러온 뒤 다시 시도해 주세요.',
    review_not_supported: '검수·실험 실행에서는 클라우드 저장과 기록 등록을 사용할 수 없습니다.',
    account_changed: '로그인 계정이 바뀌었습니다. 진행을 다시 비교해 주세요.',
    operation_not_available: '작전 선택 메뉴로 돌아가 저장이 끝난 뒤 다시 시도해 주세요.',
    menu_required: '작전 선택 메뉴로 돌아가 저장이 끝난 뒤 다시 시도해 주세요.',
    game_timeout: '게임의 응답을 확인하지 못했습니다. 게임 안의 저장 안내를 확인해 주세요.',
    local_save_pending: '이 브라우저에 저장을 마칠 때까지 새로고침하지 마세요. 게임 안의 저장 재시도 후 불러온 진행 저장 확인을 눌러 주세요.',
    reload_required: '불러온 진행의 저장 확인을 마친 뒤 새로고침해 주세요.',
    save_conflict: '다른 기기의 진행이 바뀌었습니다. 내 진행 비교를 눌러 다시 선택해 주세요.',
    save_uncertain: '저장 결과를 확인하지 못했습니다. 내 진행 비교를 눌러 최신 자료를 확인한 뒤 다시 선택해 주세요.',
    nickname_required: '랭킹에 사용할 닉네임을 먼저 등록해 주세요.',
    invalid_nickname: '닉네임은 2~12자로 입력해 주세요.', nickname_taken: '이미 사용 중인 닉네임입니다. 다른 이름을 입력해 주세요.',
    nickname_already_set: '이미 닉네임을 등록했습니다. 닉네임 다시 확인을 눌러 주세요.',
    no_cloud_save: '아직 클라우드에 저장한 진행이 없습니다.',
    choose_direction: '진행이 비슷합니다. 브라우저와 클라우드 중 사용할 진행을 직접 골라 주세요.',
    comparison_changed: '진행이 바뀌었습니다. 다시 비교한 뒤 확인해 주세요.',
    local_changed: '이 브라우저의 진행이 바뀌었습니다. 다시 비교한 뒤 확인해 주세요.',
    invalid_profile: '진행 자료를 확인하지 못했습니다. 자료를 바꾸지 않았습니다.',
    ineligible_result: '검수·실험 기록은 등록하지 않습니다.', invalid_result: '등록할 수 있는 승리 기록이 없습니다.',
    busy: '앞선 요청이 끝날 때까지 기다려 주세요.', cancelled: '취소했습니다. 진행을 바꾸지 않았습니다.',
    service_error: '요청을 마치지 못했습니다. 잠시 후 다시 시도해 주세요.',
    network_error: '연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    score_uncertain: '승리 기록의 등록 결과를 확인하지 못했습니다. 같은 기록을 중복 전송하지 않습니다.',
    score_rejected: '이번 승리 기록을 등록하지 못했습니다.',
    score_storage_unavailable: '브라우저 저장을 사용할 수 없어 이번 승리 기록을 등록하지 못했습니다.',
    score_lock_unavailable: '중복 등록 방지 기능을 사용할 수 없어 이번 승리 기록을 등록하지 못했습니다.',
    invalid_response: '서비스 응답을 확인하지 못했습니다. 진행을 바꾸지 않았습니다.'
  };
  function tell(text, error) { status.textContent = text; status.dataset.error = error ? 'true' : 'false'; }
  function errorMessage(error, login) { return login ? '로그인 준비 중' : messages[error && error.code] || '요청을 마치지 못했습니다. 잠시 후 다시 시도해 주세요.'; }
  function scoreText(value) { var n = Number(value); return Number.isFinite(n) ? n.toLocaleString('ko-KR') + '점' : '—'; }
  function timeText(value) {
    if (value === null || value === undefined || value === '') return '—';
    var n = Number(value); if (!Number.isFinite(n) || n < 0) return '—';
    var cs = Math.round(n * 100);
    return String(Math.floor(cs / 6000)).padStart(2, '0') + ':' + String(Math.floor(cs / 100) % 60).padStart(2, '0') + '.' + String(cs % 100).padStart(2, '0');
  }
  function addRow(body, values, heading) {
    var tr = document.createElement('tr');
    values.forEach(function (value, i) {
      var cell = document.createElement(heading && i === 0 ? 'th' : 'td');
      if (heading && i === 0) cell.setAttribute('scope', 'row');
      cell.textContent = String(value); tr.appendChild(cell);
    }); body.appendChild(tr);
  }
  function progressValue(progress, key, suffix) {
    if (!progress || progress[key] === undefined) return '없음';
    if (key === 'highest') return Number(progress[key]) > 0 ? '작전 ' + String(progress[key]).padStart(2, '0') : '없음';
    return String(progress[key]) + (suffix || '');
  }
  function showComparison(comparison) {
    $('account-comparison').hidden = !comparison;
    if (!comparison) return;
    var body = $('account-compare-rows'); body.replaceChildren();
    [['완료한 작전', 'cleared', '개'], ['완료한 최고 작전', 'highest', ''], ['개조 단계 합계', 'upgrades', ''], ['누적 획득 크레딧', 'totalEarned', ' CR']].forEach(function (row) {
      addRow(body, [row[0], progressValue(comparison.local, row[1], row[2]), progressValue(comparison.cloud, row[1], row[2])], true);
    });
    var wording = comparison.identical ? '두 진행이 같습니다. 바꿀 내용이 없습니다.' :
      comparison.recommendation === 'upload' ? '브라우저 진행을 권장합니다. 더 많이 진행한 자료입니다.' :
      comparison.recommendation === 'download' ? '클라우드 진행을 권장합니다. 더 많이 진행한 자료입니다.' :
      '진행이 비슷합니다. 사용할 자료를 직접 골라 주세요.';
    $('account-recommendation').textContent = wording;
    $('account-sync').hidden = comparison.identical || (comparison.recommendation !== 'upload' && comparison.recommendation !== 'download');
    $('account-save').hidden = comparison.identical;
    $('account-load').hidden = comparison.identical || !comparison.cloud;
  }
  function render(s) {
    var previous = latest; latest = s;
    if (previous && (previous.signedIn !== s.signedIn || previous.nickname !== s.nickname)) $('account-nickname').value = '';
    $('account-auth').hidden = s.signedIn;
    $('account-signed').hidden = !s.signedIn;
    $('account-review').hidden = !s.review;
    $('account-session').textContent = s.nickname ? s.nickname + '님 · Google 로그인됨' : 'Google 로그인됨';
    $('account-profile-loading').hidden = !s.profileLoading;
    $('account-name-form').hidden = !!s.nickname || s.profileLoading;
    $('account-profile-name').hidden = !s.nickname;
    $('account-profile-name').textContent = s.nickname || '';
    $('account-restore-status').hidden = !s.restoring;
    var scoreMessages = { submitting: '승리 기록을 등록하고 있습니다.', submitted: '승리 기록을 등록했습니다.', already_submitted: '이미 등록한 승리 기록입니다.' };
    $('account-score-status').textContent = s.scoreStatus ? scoreMessages[s.scoreStatus] || messages[s.scoreStatus] || '승리 기록의 등록 상태를 확인하지 못했습니다.' : '로그인과 닉네임 등록 후의 승리부터 자동으로 랭킹에 반영합니다.';
    $('account-cloud-context').textContent = s.canSync && s.canImport ? '확인하기 전에는 어느 쪽도 덮어쓰지 않습니다.' : '작전 선택 메뉴로 돌아가면 클라우드 진행을 비교합니다. 확인하기 전에는 어느 쪽도 덮어쓰지 않습니다.';
    showComparison(s.comparison);
    dialog.querySelectorAll('[data-service]').forEach(function (element) {
      element.disabled = !s.enabled || s.busy ||
        (element.hasAttribute('data-auth') && !s.signedIn) ||
        (element.hasAttribute('data-game') && (!s.ready || s.review)) ||
        (element.hasAttribute('data-write') && s.review);
    });
    if (s.lastError && (!previous || previous.lastError !== s.lastError)) tell(errorMessage({code: s.lastError}), true);
    if (!s.enabled || callbackFailed) tell('로그인 준비 중');
    if (pendingConfirmation && (!s.signedIn || s.review || previous && previous.sessionEpoch !== s.sessionEpoch)) cancelConfirmation();
    scheduleNicknamePrompt(s);
    scheduleLoginComparison(s);
  }
  function needsNickname(s) { return s && s.enabled && s.signedIn && !s.nickname && !s.profileLoading && !s.review && !s.busy && !callbackFailed && s.loginGeneration !== undefined; }
  function scheduleNicknamePrompt(s) {
    var generation = s.loginGeneration;
    if (!client || !needsNickname(s) || nicknamePrompts.has(generation) || queuedNickname === generation || pendingConfirmation) return;
    if (dialog.open) {
      if (view === 'account') { nicknamePrompts.add(generation); $('account-nickname').focus(); }
      return;
    }
    queuedNickname = generation;
    Promise.resolve().then(async function () {
      try {
        if (!needsNickname(latest) || latest.loginGeneration !== generation || nicknamePrompts.has(generation) || dialog.open) return;
        if (latest.ready) await client.pauseForAccount();
        if (!needsNickname(latest) || latest.loginGeneration !== generation || nicknamePrompts.has(generation) || dialog.open) return;
        nicknamePrompts.add(generation);
        await open('account', true);
        if (dialog.open && view === 'account' && needsNickname(latest) && latest.loginGeneration === generation) $('account-nickname').focus();
      } catch (_) { tell('게임의 일시정지 상태를 확인한 뒤 계정 창을 열어 주세요.'); }
      finally { queuedNickname = null; }
    });
  }
  function scheduleLoginComparison(s) {
    var generation = s.loginGeneration, revision = s.localRevision || '', key = generation + ':' + revision;
    if (!client || generation === undefined || !s.enabled || !s.signedIn || !s.nickname || s.profileLoading || !s.ready || !s.canSync || !s.canImport || s.review || s.busy || dialog.open || pendingConfirmation || callbackFailed || comparedStates.has(key) || queuedComparison === key) return;
    queuedComparison = key;
    Promise.resolve().then(async function () {
      queuedComparison = null;
      if (!latest.signedIn || latest.loginGeneration !== generation || (latest.localRevision || '') !== revision || !latest.canSync || !latest.canImport || latest.busy || latest.review || dialog.open || pendingConfirmation) return;
      comparedStates.add(key);
      var comparison = await run(client.compareCloud);
      if (!comparison || comparison.identical || !latest.signedIn || latest.loginGeneration !== generation || latest.review) return;
      if (!latest.canSync || !latest.canImport || dialog.open || pendingConfirmation || (latest.localRevision || '') !== revision) { comparedStates.delete(key); return; }
      await open('account');
      if (!dialog.open || view !== 'account' || !latest.canSync || !latest.canImport || latest.loginGeneration !== generation) return;
      if (comparison.recommendation === 'upload' || comparison.recommendation === 'download') {
        await run(function () { return client.syncCloud(confirmComparison); }, transferMessage).then(reloadWhenReady);
      } else tell(messages.choose_direction);
    });
  }
  var client = window.MagnetAccountClient.create({
    config: window.MagnetAccountConfig, pageUrl: location.href,
    createClient: function (url, key, options) { return window.supabase.createClient(url, key, options); }, changed: render
  });
  async function run(work, success, login) {
    tell('확인 중…');
    try { var value = await work(); if (success) tell(typeof success === 'function' ? success(value) : success); return value; }
    catch (error) { tell(errorMessage(error, login), !login && error.code !== 'cancelled'); return null; }
  }
  function cancelConfirmation() {
    if (!pendingConfirmation) return;
    var resolve = pendingConfirmation; pendingConfirmation = null;
    $('account-confirmation').hidden = true; resolve(false);
  }
  function confirmComparison(details) {
    cancelConfirmation();
    if (!dialog.open || view !== 'account' || !latest.signedIn || !latest.canSync || latest.review || details.direction === 'download' && !latest.canImport) return Promise.resolve(false);
    showComparison(details.comparison);
    var download = details.direction === 'download';
    $('account-confirm-title').textContent = download ? '클라우드 진행을 불러올까요?' : '브라우저 진행을 클라우드에 저장할까요?';
    $('account-confirm-detail').textContent = download ?
      '이 브라우저의 진행을 위 클라우드 자료로 바꿉니다. 현재 자료는 별도 백업으로 남으며, 저장이 끝나면 새로고침합니다.' :
      '클라우드 진행을 위 브라우저 자료로 바꿉니다. 다른 기기에서 불러올 진행도 함께 바뀝니다.';
    $('account-confirmation').hidden = false;
    $('account-confirmation').focus();
    return new Promise(function (resolve) { pendingConfirmation = resolve; });
  }
  function reloadWhenReady(value) {
    if (value && value.readyToReload === true) { tell('불러온 진행을 저장했습니다. 새로고침합니다.'); location.reload(); }
  }
  function transferMessage(value) { return value && value.status === 'saved' ? '클라우드에 진행을 저장했습니다.' : value && value.status === 'unchanged' ? '두 진행이 같습니다. 바꿀 내용이 없습니다.' : '진행을 확인했습니다.'; }
  function setView(next) {
    cancelConfirmation(); view = next === 'leaderboard' ? 'leaderboard' : 'account';
    $('account-page').hidden = view !== 'account'; $('account-rank-page').hidden = view !== 'leaderboard';
    $('account-title').textContent = view === 'leaderboard' ? '작전 랭킹' : '계정 · 클라우드';
    $('account-view-account').setAttribute('aria-pressed', String(view === 'account'));
    $('account-view-leaderboard').setAttribute('aria-pressed', String(view === 'leaderboard'));
  }
  async function loadRanking() {
    var request = ++rankRequest, operation = Number($('account-operation').value);
    $('account-rank-rows').replaceChildren();
    $('account-rank-caption').textContent = '작전 ' + String(operation).padStart(2, '0') + ' · 상위 50명';
    var rows = await run(function () { return client.leaderboard(operation); });
    if (request !== rankRequest || operation !== Number($('account-operation').value) || !rows) return;
    rows.slice(0, 50).forEach(function (row, index) { addRow($('account-rank-rows'), [(index + 1) + '위', row.nickname, scoreText(row.best_score), timeText(row.best_time)], false); });
    tell(rows.length ? '랭킹을 불러왔습니다.' : '아직 등록된 기록이 없습니다.');
  }
  async function open(next, alreadyPaused) {
    if (next === 'privacy') { window.open('https://lazybones-89.github.io/magnet-breaker/privacy.html', '_blank', 'noopener'); return; }
    if (!dialog.open) { returnFocus = document.activeElement; dialog.showModal(); }
    setView(next); tell(latest && latest.enabled && !callbackFailed ? '로그인 없이도 플레이할 수 있습니다.' : '로그인 준비 중');
    if (view === 'account' && needsNickname(latest)) nicknamePrompts.add(latest.loginGeneration);
    if (latest && latest.ready && !alreadyPaused) {
      try { await client.pauseForAccount(); $('account-context').textContent = '게임으로 돌아간 뒤 직접 계속할 수 있습니다.'; }
      catch (_) { $('account-context').textContent = '게임의 일시정지 상태를 확인해 주세요. 창을 닫아도 자동으로 재개하지 않습니다.'; }
    }
    if (view === 'leaderboard' && dialog.open && latest.enabled) await loadRanking();
  }
  window.MagnetAccount = {
    receive: client.receive, attachGame: function (instance, details) {
      client.attachGame(instance, details);
      if (dialog.open) client.pauseForAccount().catch(function () { $('account-context').textContent = '게임의 일시정지 상태를 확인해 주세요.'; });
    }, open: open,
    onGameState: client.onGameState, onVictory: client.onVictory,
    isOpen: function () { return dialog.open; }
  };
  $('account-button').addEventListener('click', function () { open('account'); });
  $('leaderboard-button').addEventListener('click', function () { open('leaderboard'); });
  $('privacy-link').addEventListener('click', function () { if (latest && latest.ready) client.pauseForAccount().catch(function () {}); });
  $('account-close').addEventListener('click', function () { cancelConfirmation(); dialog.close(); });
  $('account-guest').addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('cancel', cancelConfirmation);
  dialog.addEventListener('close', function () { cancelConfirmation(); if (returnFocus && returnFocus.focus) returnFocus.focus(); if (latest) { scheduleNicknamePrompt(latest); scheduleLoginComparison(latest); } });
  $('account-view-account').addEventListener('click', function () { setView('account'); });
  $('account-view-leaderboard').addEventListener('click', function () { setView('leaderboard'); if (latest.enabled) loadRanking(); });
  $('account-google').addEventListener('click', function () { run(client.signInWithGoogle, 'Google 로그인 화면으로 이동합니다.', true); });
  $('account-signout').addEventListener('click', function () { cancelConfirmation(); run(client.signOut, '로그아웃했습니다. 이 브라우저의 진행은 남아 있습니다.'); });
  $('account-name-form').addEventListener('submit', function (event) {
    event.preventDefault(); var name = $('account-nickname').value.trim();
    if (Array.from(name).length < 2 || Array.from(name).length > 12) { tell(messages.invalid_nickname, true); return; }
    run(function () { return client.setNickname(name); }, '닉네임을 등록했습니다. 다음 승리부터 랭킹에 반영합니다.');
  });
  $('account-profile-refresh').addEventListener('click', function () { run(client.refreshProfile, '닉네임을 확인했습니다.'); });
  $('account-cloud-refresh').addEventListener('click', function () { run(client.compareCloud, '진행을 비교했습니다. 사용할 자료를 골라 주세요.'); });
  $('account-save').addEventListener('click', function () { run(function () { return client.saveCloud(confirmComparison); }, transferMessage).then(reloadWhenReady); });
  $('account-load').addEventListener('click', function () { run(function () { return client.loadCloud(confirmComparison); }).then(reloadWhenReady); });
  $('account-sync').addEventListener('click', function () { run(function () { return client.syncCloud(confirmComparison); }, transferMessage).then(reloadWhenReady); });
  $('account-restore-status').addEventListener('click', function () { run(client.restoreStatus).then(reloadWhenReady); });
  $('account-confirm-yes').addEventListener('click', function () {
    if (!pendingConfirmation) return; var resolve = pendingConfirmation; pendingConfirmation = null;
    $('account-confirmation').hidden = true; resolve(true);
  });
  $('account-confirm-no').addEventListener('click', cancelConfirmation);
  $('account-operation').addEventListener('change', loadRanking);
  $('account-leaderboard').addEventListener('click', loadRanking);
  for (var operation = 1; operation <= 30; operation++) {
    var option = document.createElement('option'); option.value = operation; option.textContent = '작전 ' + String(operation).padStart(2, '0'); $('account-operation').appendChild(option);
  }
  client.init().then(function () { render(client.state()); }).catch(function () { tell('로그인 준비 중'); });
  render(client.state());
})();
