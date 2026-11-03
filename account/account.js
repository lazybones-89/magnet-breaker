(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var dialog = $('account-dialog'), status = $('account-status'), latest = null;
  var messages = {
    not_connected:'계정·클라우드 기능은 아직 연결되지 않았습니다. 게임은 현재 브라우저에 저장됩니다.',
    sign_in_required:'먼저 로그인해 주세요.', game_not_ready:'게임을 불러온 뒤 다시 시도해 주세요.',
    review_not_supported:'검수·실험 실행에서는 클라우드 저장과 기록 등록을 사용할 수 없습니다.',
    account_changed:'로그인 계정이 바뀌었습니다. 현재 계정에서 다시 시도해 주세요.',
    operation_not_available:'게임의 작전 선택 메뉴로 돌아가 브라우저 저장이 끝난 뒤 다시 시도해 주세요. 기록 등록은 결과 화면에서만 가능합니다.',
    game_timeout:'게임의 응답을 기다리다 멈췄습니다. 탭을 유지하고 게임 안의 저장 안내를 확인해 주세요.',
    local_save_pending:'불러온 자료를 브라우저에 저장하는 중이거나 저장에 실패했습니다. 게임 안의 저장 재시도를 누른 뒤 «복원 저장 확인»을 눌러 주세요. 아직 새로고침하지 마세요.',
    reload_required:'복원한 자료의 브라우저 저장을 확인한 뒤 새로고침해야 합니다.',
    save_conflict:'다른 기기에서 클라우드 저장이 바뀌었습니다. 자동으로 덮어쓰지 않았습니다. «클라우드 상태 새로 읽기» 후 최신 자료를 불러오거나, 현재 브라우저 자료 저장을 다시 선택해 주세요.',
    retry_pending:'전송 결과를 확인하지 못한 저장이 있습니다. «같은 저장 다시 확인»으로 먼저 확인해 주세요.',
    nickname_required:'닉네임은 공백만 제외한 1~24자로 입력해 주세요.',
    no_cloud_save:'아직 이 계정의 클라우드 저장이 없습니다.',
    ineligible_result:'검수·실험 기록은 등록할 수 없습니다.',
    invalid_result:'현재 결과를 등록할 수 없습니다. 정상 플레이 결과 화면에서 다시 시도해 주세요.',
    busy:'앞선 요청이 끝날 때까지 기다려 주세요.', cancelled:'취소했습니다.',
    service_error:'요청을 완료하지 못했습니다. 입력과 연결 상태를 확인해 주세요. 저장 전송 중이었다면 «같은 저장 다시 확인»을 사용할 수 있습니다.',
    invalid_response:'서비스 응답을 확인하지 못했습니다. 자료를 덮어쓰지 말고 연결 설정을 확인해 주세요.'
  };
  function tell(text, error) { status.textContent = text; status.dataset.error = error ? 'true' : 'false'; }
  function render(s) {
    if (latest && (latest.signedIn !== s.signedIn || latest.email !== s.email)) { $('account-nickname').value = ''; $('account-delete-check').checked = false; }
    latest = s;
    $('account-session').textContent = s.signedIn ? '로그인됨 · ' + s.email : '로그인하지 않음';
    $('account-disabled').hidden = s.enabled;
    $('account-auth').hidden = s.signedIn;
    $('account-signed').hidden = !s.signedIn;
    $('account-recovery').hidden = !s.recovery;
    if (s.recovery && !dialog.open) dialog.showModal();
    $('account-review').hidden = !s.review;
    $('account-save-retry').hidden = !s.retrySave;
    $('account-restore-status').hidden = !s.restoring;
    $('account-nickname').placeholder = s.nickname || '새 기록에 사용할 이름';
    $('account-cloud-status').textContent = s.conflict ? '저장 충돌 · 선택이 필요합니다.' : s.remote ?
      (s.remote.found ? '클라우드 저장 있음' + (s.remote.updatedAt ? ' · ' + new Date(s.remote.updatedAt).toLocaleString('ko-KR') : '') : '클라우드 저장 없음') : '클라우드 상태를 아직 읽지 않았습니다.';
    dialog.querySelectorAll('[data-service]').forEach(function (element) {
      element.disabled = !s.enabled || s.busy || (element.hasAttribute('data-auth') && !s.signedIn) ||
        (element.hasAttribute('data-game') && (!s.ready || s.review));
    });
    $('account-operation').disabled = !s.enabled || s.busy || $('account-mode').value === 'endless';
  }
  var client = window.MagnetAccountClient.create({
    config: window.MagnetAccountConfig, pageUrl: location.href,
    createClient: function (url, key) { return window.supabase.createClient(url, key); }, changed: render
  });
  window.MagnetAccount = {
    receive: client.receive, attachGame: client.attachGame,
    isOpen: function () { return dialog.open; }
  };
  async function run(work, success) {
    tell('처리 중…');
    try { var value = await work(); if (success) tell(typeof success === 'function' ? success(value) : success); return value; }
    catch (error) { tell(messages[error.code] || '요청을 완료하지 못했습니다. 연결 상태와 게임 안의 안내를 확인해 주세요.', error.code !== 'cancelled'); return null; }
  }
  function confirmText(text) { return function () { return window.confirm(text); }; }
  function reloadWhenReady(value) { if (value && value.readyToReload === true) { tell('이 브라우저에 복원 저장을 완료했습니다. 새로고침합니다.'); location.reload(); } }
  $('account-button').addEventListener('click', function () {
    dialog.showModal(); if (!latest.enabled) tell(messages.not_connected);
    else if (!latest.signedIn) $('account-email').focus();
  });
  $('account-close').addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('close', function () { $('account-button').focus(); });
  $('account-auth-form').addEventListener('submit', function (event) {
    event.preventDefault(); var email = $('account-email').value.trim(), password = $('account-password').value;
    $('account-password').value = ''; run(function () { return client.signIn(email, password); }, '로그인했습니다.');
  });
  $('account-signup').addEventListener('click', function () {
    if (!$('account-auth-form').reportValidity()) return;
    var email = $('account-email').value.trim(), password = $('account-password').value; $('account-password').value = '';
    run(function () { return client.signUp(email, password); }, '가입 요청을 보냈습니다. 이메일의 확인 링크를 열어 주세요. 기존 계정이라면 로그인 또는 비밀번호 재설정을 이용해 주세요.');
  });
  $('account-reset').addEventListener('click', function () {
    if (!$('account-email').reportValidity()) return;
    run(function () { return client.resetPassword($('account-email').value.trim()); }, '해당 주소로 안내를 보낼 수 있으면 비밀번호 재설정 메일이 발송됩니다. 메일의 링크를 확인해 주세요.');
  });
  $('account-password-form').addEventListener('submit', function (event) {
    event.preventDefault(); var password = $('account-new-password').value; $('account-new-password').value = '';
    run(function () { return client.changePassword(password); }, '비밀번호를 변경했습니다.');
  });
  $('account-signout').addEventListener('click', function () { run(client.signOut, '이 브라우저에서 로그아웃했습니다. 게임의 로컬 진행 자료는 그대로 남아 있습니다.'); });
  $('account-name-form').addEventListener('submit', function (event) {
    event.preventDefault(); run(function () { return client.setNickname($('account-nickname').value); }, '앞으로 등록하는 기록의 닉네임을 저장했습니다. 기존 기록의 이름은 바뀌지 않습니다.');
  });
  $('account-cloud-refresh').addEventListener('click', function () { run(client.refreshCloud, '클라우드 상태를 다시 읽었습니다. 게임 자료는 바꾸지 않았습니다.'); });
  $('account-save').addEventListener('click', function () {
    run(function () { return client.saveCloud(confirmText('현재 브라우저의 진행 자료로 기존 클라우드 저장을 바꿀까요? 다른 기기의 진행이 더 최신일 수 있습니다.')); }, '클라우드에 저장했습니다.');
  });
  $('account-save-retry').addEventListener('click', function () { run(client.retrySave, '같은 저장 요청을 확인했습니다. 클라우드에 저장되었습니다.'); });
  $('account-load').addEventListener('click', function () {
    run(function () { return client.loadCloud(confirmText('클라우드 자료를 이 브라우저로 불러올까요? 현재 로컬 자료는 별도 백업으로 보존됩니다. 작전 선택 메뉴에서만 가능하며, 저장 완료 후 페이지가 새로고침됩니다.')); }).then(reloadWhenReady);
  });
  $('account-restore-status').addEventListener('click', function () { run(client.restoreStatus).then(reloadWhenReady); });
  $('account-submit-result').addEventListener('click', function () {
    run(function () { return client.submitResult($('account-nickname').value.trim() || latest.nickname); }, '현재 결과를 등록했습니다. 랭킹에는 각 계정의 최고 기록 하나가 표시됩니다.');
  });
  $('account-mode').addEventListener('change', function () { render(latest); });
  $('account-leaderboard').addEventListener('click', function () {
    run(function () { return client.leaderboard($('account-mode').value, $('account-mode').value === 'endless' ? 0 : Number($('account-operation').value)); }).then(function (rows) {
      if (!rows) return; var body = $('account-rank-rows'); body.replaceChildren();
      rows.forEach(function (row) {
        var tr = document.createElement('tr');
        [row.rank, row.display_name, row.score, row.kills].forEach(function (text) { var td = document.createElement('td'); td.textContent = String(text); tr.appendChild(td); }); body.appendChild(tr);
      });
      tell(rows.length ? '랭킹을 불러왔습니다. 브라우저에서 제출한 미검증 기록입니다.' : '아직 등록된 기록이 없습니다.');
    });
  });
  $('account-delete').addEventListener('click', function () {
    if (!$('account-delete-check').checked) { tell('계정 삭제 안내를 확인한 뒤 확인란을 선택해 주세요.', true); return; }
    run(function () { return client.deleteAccount(confirmText('계정을 영구 삭제할까요? 계정의 클라우드 저장과 랭킹 기록이 삭제됩니다. 복구할 수 없습니다. 이 브라우저의 로컬 진행 자료는 삭제하지 않습니다.')); }, '계정과 서버 자료를 삭제했습니다. 이 브라우저의 로컬 진행 자료는 남아 있습니다.');
  });
  for (var operation = 1; operation <= 30; operation++) { var option = document.createElement('option'); option.value = operation; option.textContent = '작전 ' + String(operation).padStart(2, '0'); $('account-operation').appendChild(option); }
  client.init().then(function () { render(client.state()); }).catch(function () { tell('계정 연결을 확인하지 못했습니다. 게임의 로컬 저장은 계속 사용할 수 있습니다.', true); });
  render(client.state());
})();
