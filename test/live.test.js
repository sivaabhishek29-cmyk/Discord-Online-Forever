// Offline test (real Eris, fake socket): the LIVE badge. The account asks for
// it after joining, puts it back when it goes, backs off when Discord keeps
// removing it, and stops when told to. Run with: npm test (takes ~8s)
const assert = require("assert");
const h = require("./harness.js");

h.start({ LIVE_RETRY: "300", WATCHDOG_INTERVAL: "60", REJOIN_DELAY: "40" });
const replies = [];
require("eris").Client.prototype.createMessage = async (channelId, content) => { replies.push(content); return { id: "1" }; };
let nextId = 9000;
const say = (content) =>
  h.dispatch("MESSAGE_CREATE", {
    id: String(++nextId), channel_id: "444444444444444444", content, type: 0, timestamp: new Date().toISOString(),
    author: { id: h.ME, username: "me", discriminator: "0" },
    mentions: [], mention_roles: [], attachments: [], embeds: [],
  });

const KEY = `guild:${h.GUILD}:${h.VC}:${h.ME}`;
const asks = () => h.sentOp(18).length;
const logged = (text) => h.logs.some((l) => l.includes(text));

h.finish("LIVE TEST", async () => {
  await h.until(() => h.socket() && h.sentOp(2).length === 1, "login");
  h.ready();
  await h.until(() => h.sentOp(4).length === 1, "join");
  assert.strictEqual(asks(), 0, "nothing is asked before the join is confirmed");
  h.voiceState(h.VC);

  // Joined → ask for the badge: "create stream" then "not paused".
  await h.until(() => asks() === 1 && h.sentOp(22).length === 1, "badge asked for after joining");
  assert.deepStrictEqual(h.sentOp(18)[0].d, { type: "guild", guild_id: h.GUILD, channel_id: h.VC, preferred_region: null });
  assert.deepStrictEqual(h.sentOp(22)[0].d, { stream_key: KEY, paused: false });
  assert.strictEqual(h.sentOp(4).length, 1, "asking for the badge does not touch the voice state");

  // Discord shows it → nothing more is sent.
  h.voiceState(h.VC, "gateway-session", { self_stream: true });
  await h.until(() => logged("🔴 LIVE badge is showing"), "badge confirmed");
  await h.sleep(700);
  assert.strictEqual(asks(), 1, "no repeats while the badge is on");
  say("!live");
  await h.until(() => replies.some((r) => /^LIVE badge: showing for \d+s\.$/.test(r)), "!live reply");

  // Discord takes it away → asked again, but only after the retry wait.
  h.dispatch("STREAM_DELETE", { stream_key: KEY, reason: "stream_ended" });
  h.voiceState(h.VC, "gateway-session", { self_stream: false });
  await h.until(() => logged("⚪ LIVE badge went off") && logged("Discord ended the stream (stream_ended)"), "badge loss noticed");
  await h.sleep(150);
  assert.strictEqual(asks(), 1, "not asked again straight away");
  await h.until(() => asks() === 2, "asked again after the wait");
  h.voiceState(h.VC, "gateway-session", { self_stream: true });
  await h.sleep(50);

  // Kicked → rejoin → the badge is asked for again at once.
  h.voiceState(null);
  await h.until(() => h.sentOp(4).length === 2, "rejoin");
  h.voiceState(h.VC);
  await h.until(() => asks() === 3, "badge asked for after the rejoin");
  h.voiceState(h.VC, "gateway-session", { self_stream: true });
  await h.sleep(50);

  // Switched off from chat: the stream is ended and never asked for again.
  say("!live off");
  await h.until(() => replies.includes("LIVE badge off."), "!live off reply");
  assert.deepStrictEqual(h.sentOp(19).map((p) => p.d), [{ stream_key: KEY }]);
  h.voiceState(h.VC, "gateway-session", { self_stream: false });
  await h.sleep(700);
  assert.strictEqual(asks(), 3, "off means off");

  // Switched back on.
  say("!live on");
  await h.until(() => asks() === 4 && replies.includes("Asked Discord for the LIVE badge."), "!live on");

  // Discord keeps not showing it: 5 misses, then it slows down 15x and says so once.
  await h.until(() => logged("Discord is not keeping the LIVE badge on"), "backs off after repeated misses", 6000);
  const slow = asks();
  await h.sleep(900);
  assert.strictEqual(asks(), slow, "asks far less often after backing off");
  assert.strictEqual(h.logs.filter((l) => l.includes("Discord is not keeping the LIVE badge on")).length, 1, "said once");

  // Refused outright (no permission): stop until the next join, with a clear reason.
  say("!live on"); // clears the back-off
  await h.until(() => asks() === slow + 1, "asked again");
  h.dispatch("STREAM_DELETE", { stream_key: KEY, reason: "unauthorized" });
  await h.until(() => logged('Discord refused the LIVE badge (unauthorized)'), "refusal explained");
  await h.sleep(700);
  assert.strictEqual(asks(), slow + 1, "no retries after a refusal");
  say("!live");
  await h.until(() => replies.includes("LIVE badge: refused by Discord (unauthorized)."), "refusal in !live");
  h.voiceState(null);
  await h.until(() => h.sentOp(4).length === 3, "rejoin after another kick");
  h.voiceState(h.VC);
  await h.until(() => asks() === slow + 2, "a new join tries again");
});
