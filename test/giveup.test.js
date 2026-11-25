// Offline test (real Eris, fake socket): some disconnects make the library give
// up for good. The app must start a fresh connection by itself — unless the
// token was rejected, where retrying is pointless. Run with: npm test
const assert = require("assert");
const h = require("./harness.js");

h.start({ JOIN_CONFIRM_TIMEOUT: "150", READY_TIMEOUT: "100", RECONNECT_AFTER: "300" });

const joins = () => h.sentOp(4).filter((p) => p.d.channel_id === h.VC).length;

h.finish("GIVE-UP TEST", async () => {
  await h.until(() => h.socket() && h.sentOp(2).length === 1, "login");
  h.ready();
  await h.until(() => joins() === 1, "first join");
  h.voiceState(h.VC);

  // 4002 = "invalid message": the library closes and does not reconnect.
  h.socket().drop(4002);
  await h.until(() => h.logs.some((l) => l.includes("starting a fresh connection")), "self-restart of the connection", 5000);
  await h.until(() => h.sentOp(2).length === 2, "second login", 5000);
  h.ready("gateway-session-2");
  await h.until(() => joins() === 2, "rejoin after the fresh connection");
  h.voiceState(h.VC, "gateway-session-2");
  await h.until(() => h.logs.filter((l) => l.includes("✅ Joined #Lounge")).length === 2, "back in the channel");

  // 4004 = token rejected: say so, and do not hammer Discord with a bad token.
  const sockets = h.sockets.length;
  h.socket().drop(4004);
  await h.until(() => h.logs.some((l) => l.includes("Discord rejected the token")), "token rejection explained");
  await h.sleep(900);
  assert.strictEqual(h.sockets.length, sockets, "no reconnect attempts with a rejected token");
  assert(!h.logs.some((l) => l.includes(h.TOKEN)), "token never appears in logs");
});
