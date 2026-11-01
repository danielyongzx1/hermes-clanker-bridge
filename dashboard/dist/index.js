// The web dashboard needs an entry for every plugin with a dashboard folder. This plugin only uses
// that folder for its backend route; its page is in Hermes Desktop (Settings → Plugins), so this
// registers an empty, hidden one.
(function () {
  window.__HERMES_PLUGINS__.register('hermes-clanker-bridge', function () { return null; });
})();
