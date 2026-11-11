/* Typography only: account.js retains its original strings and behavior. */
(function () {
  'use strict';
  var title = document.getElementById('account-title');
  if (!title) return;
  function normalizeTitle() {
    var value = title.textContent;
    if (value.indexOf('\u00b7') !== -1) title.textContent = value.replace(/\u00b7/g, '/');
  }
  normalizeTitle();
  new MutationObserver(normalizeTitle).observe(title, { childList: true, characterData: true, subtree: true });
}());
