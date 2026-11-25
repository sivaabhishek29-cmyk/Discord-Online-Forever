// Offline test (real Eris, fake socket): the account gets put back in the VC
// even when nobody tells the app it dropped out. Run with: npm test
const assert = require("assert");
const h = require("./harness.js");

h.start({ JOIN_CONFIRM_TIMEOUT: "150", REJOIN_DELAY: "40", WATCHDOG_INTERVAL: "50", REASSERT_INTERVAL: "300" });

const joins = () => h.sentOp(4).filter((p) => p.d.channel_id === h.VC);

h.finish("REASSERT TEST", async () => {
  await h.until(() => h.socket() && h.sentOp(2).length === 1, "login");
  h.ready("gateway-session", {
    sessions: [{ session_id: "gateway-session", status: "online", activities: [] }],
  });
  await h.until(() => joins().length === 1, "first join");
  h.voiceState(h.VC);
  await h.until(() => h.logs.some((l) => l.includes("✅ Joined #Lounge")), "join confirmed");

  // 1. While sitting in the channel, "I'm in this channel" is repeated now and
  //    then with the exact same flags. Discord ignores it if nothing changed, and
  //    it puts the account back if it had been dropped without any notice.
  await h.until(() => joins().length === 2, "periodic re-assert", 2000);
  assert.deepStrictEqual(joins()[1].d, joins()[0].d, "re-assert is identical to the join (no visible change)");
  assert(!h.logs.some((l) => l.includes("did not confirm")), "a silent re-assert is not treated as a failure");
  assert.strictEqual(h.logs.filter((l) => l.includes("🎧 Joining")).length, 1, "re-asserts are not logged as joins");

  // 2. Another device takes voice: we leave it alone, re-asserts stop...
  h.dispatch("SESSIONS_REPLACE", [
    { session_id: "gateway-session", status: "online", activities: [] },
    { session_id: "phone", status: "online", client_info: { client: "mobile", os: "android" }, activities: [] },
  ]);
  h.voiceState(h.VC, "phone");
  await h.sleep(500);
  const held = joins().length;
  await h.sleep(500);
  assert.strictEqual(joins().length, held, "does not fight or re-assert while another device holds voice");

  // 3. ...but when that device disappears without a "left voice" message, the
  //    watchdog notices it is gone and takes the channel back.
  h.dispatch("SESSIONS_REPLACE", [{ session_id: "gateway-session", status: "online", activities: [] }]);
  await h.until(() => h.logs.some((l) => l.includes("other device that held voice is gone")), "stale hold noticed");
  await h.until(() => joins().length === held + 1, "rejoin after the other device vanished");
  h.voiceState(h.VC);
  await h.until(() => h.logs.filter((l) => l.includes("✅ Joined #Lounge")).length === 2, "back in the channel");
});
