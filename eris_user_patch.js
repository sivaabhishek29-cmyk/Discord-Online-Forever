// Eris 0.17 still does a "guild sync" step for user accounts: after login it
// asks Discord to sync every server and waits for a reply before it reports
// "ready". Discord removed that feature years ago, so the reply never comes
// and the client stays "not ready" forever, even though the login succeeded.
//
// This skips the sync step so the client becomes ready right after login.
const Eris = require("eris");

function applyUserAccountPatch() {
  const Shard = Eris.Shard;
  if (!Shard || !Shard.prototype || Shard.prototype._stayPatched) return false;
  Shard.prototype._stayPatched = true;

  // createGuild() does `++unsyncedGuilds; syncGuild(id)` — undo the counter
  // and never queue or send the obsolete request.
  Shard.prototype.syncGuild = function syncGuild() {
    this.unsyncedGuilds = 0;
    this.guildSyncQueue = [];
    this.guildSyncQueueLength = 1;
  };
  Shard.prototype.requestGuildSync = function requestGuildSync() {};
  return true;
}

// Safety net: if a shard has logged in but still isn't flagged ready, clear
// whatever it is waiting for and let it finish.
function forceShardReady(shard) {
  if (!shard || shard.ready || shard.status !== "ready") return false;
  shard.unsyncedGuilds = 0;
  shard.guildSyncQueue = [];
  shard.guildSyncQueueLength = 1;
  shard.getAllUsersQueue = [];
  shard.getAllUsersCount = {};
  shard.checkReady();
  return !!shard.ready;
}

module.exports = { applyUserAccountPatch, forceShardReady };
