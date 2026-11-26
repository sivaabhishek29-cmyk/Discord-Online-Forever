// Alerts go to a channel webhook from the server itself: first the sender on
// its own, then the whole app (real Eris, fake socket) through a kick, a long
// disconnect and a rejected token. Also the countdown set from chat.
// Run with: npm test
const assert = require("assert");
const { createAlerts, cleanWebhookUrl, formatGap } = require("../alerts.js");

const HOOK = "https://discord.com/api/webhooks/123456789012345678/abc-DEF_123";

assert.strictEqual(cleanWebhookUrl(` "${HOOK}?wait=true" `), HOOK);
assert.strictEqual(cleanWebhookUrl("https://discordapp.com/api/v10/webhooks/1/x/"), "https://discordapp.com/api/v10/webhooks/1/x");
assert.strictEqual(cleanWebhookUrl("https://evil.example/api/webhooks/1/x"), null);
assert.strictEqual(cleanWebhookUrl("http://discord.com/api/webhooks/1/x"), null);
assert.strictEqual(cleanWebhookUrl(""), null);
assert.strictEqual(formatGap(6400), "6s");
assert.strictEqual(formatGap(185000), "3m 5s");
assert.strictEqual(formatGap(26 * 3600000), "1d 2h");

const posts = []; // every request made with fetch
let failNext = false;
const fakeFetch = async (url, options) => {
  posts.push({ url, options, body: options && options.body ? JSON.parse(options.body) : null });
  if (failNext) { failNext = false; throw new Error(`connect failed for ${url}`); }
  return { ok: true, status: 204, json: async () => ({}) };
};
const texts = () => posts.filter((p) => p.url === HOOK).map((p) => p.body.content);

async function senderTests() {
  let t = 0;
  const logged = [];
  const a = createAlerts({ url: HOOK, name: () => "Tester", fetchImpl: fakeFetch, now: () => t, log: (l) => logged.push(l), maxInWindow: 3, windowMs: 1000 });
  assert.strictEqual(a.enabled, true);
  a.send("one");
  await a.idle();
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].url, HOOK);
  assert.strictEqual(posts[0].options.method, "POST");
  assert.deepStrictEqual(posts[0].body, { content: "**Tester** — one", allowed_mentions: { parse: [] } });
  assert(!JSON.stringify(posts[0].options.headers).toLowerCase().includes("authorization"), "no account token is sent");

  // Flood protection: 3 alerts, one notice, then silence until the window clears.
  a.send("two"); a.send("three"); a.send("four"); a.send("five");
  await a.idle();
  const sent = texts().slice(1).map((c) => c.replace("**Tester** — ", ""));
  assert.deepStrictEqual(sent.slice(0, 2), ["two", "three"]);
  assert.strictEqual(sent.length, 3, "one notice, then nothing more");
  assert(sent[2].startsWith("🔕 Too many alerts."), sent[2]);
  t = 2000;
  a.send("six");
  await a.idle();
  assert(texts()[texts().length - 1].endsWith("six"));

  // A failed delivery is logged without the webhook link.
  failNext = true;
  t = 9000;
  a.send("seven");
  await a.idle();
  assert(logged.some((l) => l.includes("Alert not delivered")), "failure is logged");
  assert(!logged.some((l) => l.includes("abc-DEF_123")), "the webhook link is never logged");

  // No link, or a wrong one: quietly off.
  const before = posts.length;
  for (const url of [undefined, "https://example.com/hook"]) {
    const off = createAlerts({ url, fetchImpl: fakeFetch });
    assert.strictEqual(off.enabled, false);
    assert.strictEqual(off.send("x"), false);
  }
  assert.strictEqual(posts.length, before);
  posts.length = 0;
  console.log("ALERT SENDER PASSED");
}

// --- The whole app ----------------------------------------------------------
const h = require("./harness.js");
let nextId = 9000;
const say = (content) =>
  h.dispatch("MESSAGE_CREATE", {
    id: String(++nextId), channel_id: "444444444444444444", content, type: 0, timestamp: new Date().toISOString(),
    author: { id: h.ME, username: "me", discriminator: "0" },
    mentions: [], mention_roles: [], attachments: [], embeds: [],
  });
const card = () => (h.shownActivities() || []).find((a) => a.application_id) || {};
const custom = () => (h.shownActivities() || []).find((a) => a.type === 4) || {};
const alerted = (re) => texts().some((c) => re.test(c));

h.finish("ALERTS TEST", async () => {
  await senderTests();

  h.start({
    ALERT_WEBHOOK_URL: HOOK, ALERT_OFFLINE_AFTER: "400", ALERT_VC_AFTER: "100000",
    REJOIN_DELAY: "40", WATCHDOG_INTERVAL: "100000", RECONNECT_AFTER: "100000",
  });
  global.fetch = fakeFetch; // set after start(): the harness blocks the network
  const replies = [];
  require("eris").Client.prototype.createMessage = async (channelId, content) => { replies.push(content); return { id: "1" }; };

  await h.until(() => h.socket() && h.sentOp(2).length === 1, "login");
  h.ready();
  await h.until(() => h.sentOp(4).length === 1, "join");
  h.voiceState(h.VC);
  await h.until(() => alerted(/^\*\*me\*\* — 🟢 Online \(the app has just started\)\.$/), "start alert");
  assert(h.logs.some((l) => l.includes("🔔 Alerts: on")));
  assert(!h.logs.some((l) => l.includes("abc-DEF_123")), "the webhook link is not in the logs");

  // Default refresh is once a minute: no seconds in the text, clock counts up.
  await h.until(() => custom().state === "In VC for 00d-00h-00m", "status text without seconds");
  assert(card().timestamps.start && !card().timestamps.end, "clock counts up by default");
  // The second card's bar by default: its left-hand figure is India's time of
  // day (same start as card 1's clock), and it is 23:56:04 long.
  const bar = h.shownActivities()[2];
  assert.strictEqual(bar.timestamps.start, card().timestamps.start, "bar and clock both start at India midnight");
  const india = new Date(Date.now() + 5.5 * 3600000);
  const timeOfDay = ((india.getUTCHours() * 60 + india.getUTCMinutes()) * 60 + india.getUTCSeconds()) * 1000;
  assert(Math.abs(Date.now() - bar.timestamps.start - timeOfDay) < 2000, "the bar reads the time in India");
  assert.strictEqual(bar.details, "Activity Intervel 🦈");
  assert(/^Day \d+$/.test(bar.state), `line 2 counts days: ${bar.state}`);
  assert.strictEqual(bar.application_id, "1575297984684363846");
  assert.strictEqual(bar.timestamps.end - bar.timestamps.start, ((23 * 60 + 56) * 60 + 4) * 1000);

  // Kicked → alert, automatic rejoin → "back" alert.
  h.voiceState(null);
  await h.until(() => alerted(/⚠️ Removed from #Lounge \(kicked or disconnected\)\. Rejoining…$/), "kick alert");
  await h.until(() => h.sentOp(4).length === 2, "rejoin");
  h.voiceState(h.VC);
  await h.until(() => alerted(/✅ Back in #Lounge after \d+s\.$/), "back-in-voice alert");

  // Countdown from chat: the clock gets an end time; "off" restores counting up.
  say("!countdown 31-12-2099 23:59");
  await h.until(() => replies.some((r) => /^Counting down to 31-12-2099 23:59 \(UTC\+05:30\) — \d+d \d+h left\.$/.test(r)), "countdown reply");
  await h.until(() => card().timestamps && card().timestamps.end === Date.UTC(2099, 11, 31, 18, 29), "countdown on the card");
  assert(!card().timestamps.start, "only an end time is sent");
  say("!countdown yesterday");
  await h.until(() => replies.some((r) => r.startsWith("I could not read that date.")), "bad date reply");
  say("!countdown 01-01-2020");
  await h.until(() => replies.some((r) => r.includes("is already in the past")), "past date reply");
  assert.strictEqual(card().timestamps.end, Date.UTC(2099, 11, 31, 18, 29), "a bad date changes nothing");
  say("!countdown off");
  await h.until(() => card().timestamps && card().timestamps.start && !card().timestamps.end, "counting up again");

  // A short drop that resumes straight away: no alert.
  const before = texts().length;
  h.socket().drop(1006);
  await h.until(() => h.sockets.length === 2 && h.sentOp(6).length === 1, "resume", 12000);
  h.socket().receive({ op: 0, s: h.lastSeq(), t: "RESUMED", d: {} });
  await h.sleep(300);
  assert.strictEqual(texts().length, before, "no alert for a quick reconnect");

  // A long one: "offline" alert, then "back online" with how long it took.
  h.socket().drop(1006);
  await h.until(() => alerted(/🔴 Offline for \d+s\. Reconnecting…$/), "offline alert", 12000);
  await h.until(() => h.sockets.length === 3 && h.sentOp(6).length === 2, "second resume", 12000);
  h.socket().receive({ op: 0, s: h.lastSeq(), t: "RESUMED", d: {} });
  await h.until(() => alerted(/🟢 Back online after \d+s\.$/), "back-online alert");
  assert.strictEqual(texts().filter((c) => /🔴 Offline/.test(c)).length, 1, "one offline alert per outage");

  // Token rejected: one clear alert, and the token itself never leaves.
  h.socket().drop(4004);
  await h.until(() => alerted(/❌ Discord rejected the token\. Put a fresh token in the Railway `token` variable\.$/), "token alert", 12000);
  await h.sleep(600);
  assert.strictEqual(texts().filter((c) => /rejected the token/.test(c)).length, 1, "said once");
  assert(!JSON.stringify(posts).includes(h.TOKEN), "the account token is never posted");
  assert(posts.every((p) => p.url === HOOK || !/webhooks/.test(p.url)), "alerts only go to the configured webhook");
});
