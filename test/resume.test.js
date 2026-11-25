// Offline test (real Eris, fake socket): the account must keep being counted
// as "in VC" through the things that happen on a long-running connection.
// Run with: npm test
const assert = require("assert");
const h = require("./harness.js");

h.start({ JOIN_CONFIRM_TIMEOUT: "150", REJOIN_DELAY: "40", WATCHDOG_INTERVAL: "100000" });

const inVcCard = () => {
  const acts = h.shownActivities() || [];
  const card = acts.find((a) => a.application_id);
  return !!(card && card.details === "Chilling in Lounge" && card.timestamps);
};
const joins = () => h.sentOp(4).filter((p) => p.d.channel_id === h.VC).length;

h.finish("RESUME TEST", async () => {
  await h.until(() => h.socket() && h.sentOp(2).length === 1, "login");
  h.ready();
  await h.until(() => joins() === 1, "first join");
  h.voiceState(h.VC);
  await h.until(() => h.logs.some((l) => l.includes("✅ Joined #Lounge")), "join confirmed");
  await h.until(inVcCard, "card showing the channel");

  // 1. Another device of the same account logs in. The official app announces
  //    "not in voice on this device" — that is not us leaving the channel.
  h.dispatch("VOICE_STATE_UPDATE", {
    user_id: h.ME, guild_id: null, channel_id: null, session_id: "phone-session",
    self_mute: true, self_deaf: false, mute: false, deaf: false,
  });
  await h.sleep(150);
  assert.strictEqual(joins(), 1, "another device's 'not in voice' is ignored");
  assert(inVcCard(), "card still says in VC after another device logs in");

  // 2. Routine reconnect: Discord drops the socket, Eris resumes the SAME session.
  //    The account never left the channel, so nothing may be reset.
  const before = h.sockets.length;
  h.socket().drop(1006);
  await h.until(() => h.sockets.length === before + 1 && h.sentOp(6).length === 1, "resume to be sent", 8000);
  h.socket().receive({ op: 0, s: h.lastSeq(), t: "RESUMED", d: {} });
  await h.until(() => h.logs.some((l) => l.includes("still in #Lounge")), "resume recognised");
  await h.sleep(400); // longer than the join-confirm timeout
  assert.strictEqual(joins(), 1, "no re-join after a resume");
  assert(!h.logs.some((l) => l.includes("did not confirm")), "no bogus 'did not confirm' after a resume");
  assert(inVcCard(), "card still says in VC after a resume");

  // 3. A real kick still triggers a rejoin...
  h.voiceState(null);
  await h.until(() => joins() === 2, "rejoin after a kick");
  assert.strictEqual(h.sentOp(4).pop().d.self_deaf, true, "first attempt uses the normal flags");
  // ...and if Discord stays silent (it does not echo a state it thinks is unchanged),
  // the next attempt changes a flag so Discord has to answer.
  await h.until(() => joins() === 3, "second attempt after no confirmation");
  assert.strictEqual(h.sentOp(4).pop().d.self_deaf, false, "retry flips a flag to force an answer");
  h.voiceState(h.VC, "gateway-session", { self_deaf: false });
  await h.until(() => joins() === 4, "correct flags re-applied after the forced answer");
  assert.strictEqual(h.sentOp(4).pop().d.self_deaf, true);
  h.voiceState(h.VC);
  await h.until(inVcCard, "card back to in VC");

  // 4. A brand-new session (not a resume) does start from scratch and joins again.
  const n = joins();
  h.socket().receive({ op: 9, d: false }); // invalid session -> Eris identifies again
  await h.until(() => h.sentOp(2).length === 2, "fresh identify", 12000);
  h.ready("gateway-session-2");
  await h.until(() => joins() === n + 1, "join on the new session");
  h.voiceState(h.VC, "gateway-session-2");
  await h.until(inVcCard, "card in VC on the new session");
});
