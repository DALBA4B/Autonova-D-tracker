// Shared config. Loaded as a content script before content.js, and via importScripts in background.
(function (global) {
  const CFG = {
    SUPABASE_URL: 'https://zsnecazcpmbqezlylnjr.supabase.co',
    SUPABASE_KEY: 'sb_publishable_vwjHxkye6sID82IH62NM9Q_KlV8LOEa',
    EXPECTED_CLIENT_CODE: '48320',
    ORDER_NUMBER_REGEX: /ЗК-\d+/,
    HISTORY_URL_FRAGMENT: 'index.html?id=27',
    BADGE_CLASS: 'ext-orderer-badge',
    MSG_NS: 'ANO_EXT'
  };
  global.ANO_CFG = CFG;
})(typeof self !== 'undefined' ? self : this);
