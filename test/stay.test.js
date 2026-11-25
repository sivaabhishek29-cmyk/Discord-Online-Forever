// Offline test: runs index.js against a fake Eris client (no Discord needed).
// Run with: npm test
const Module = require("module");
const EventEmitter = require("events");
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const ME = "111111111111111111";
const GUILD = "222222222222222222";
const VC = "333333333333333333";
const VC2 = "444444444444444444";

const APP_ID = "999999999999999999";
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "stay-test-"));
// A total saved by an "earlier run": 2 days 3 hours.
fs.writeFileSync(path.join(DATA_DIR, "vc-timer.json"), JSON.stringify({ totalMs: (51 * 60 + 5) * 60000 }));

// Discord's public application endpoints, faked.
global.fetch = async (url) => ({
  ok: true,
  json: async () =>
    String(url).endsWith("/rpc")
      ? { id: APP_ID, name: "My App" }
      : [{ id: "777", name: "logo", type: 1 }, { id: "888", name: "other", type: 1 }],
});

const presences = []; // every status/activity update index.js sends
const sent = []; // every gateway message index.js sends
const logs = [];
let client = null;

class FakeShard {
  constructor() { this.id = 0; this.status = "ready"; }
  sendWS(op, d) { sent.push({ op, d }); }
}
class FakeClient extends EventEmitter {
  constructor() {
    super();
    client = this;
    this.user = { id: ME, username: "me" };
    this.ready = false;
    const guild = { id: GUILD, name: "Guild", channels: new Map() };
    for (const id of [VC, VC2]) guild.channels.set(id, { id, name: "vc-" + id.slice(0, 3), type: 2, guild });
    this.guilds = new Map([[GUILD, guild]]);
    this.shards = new Map([[0, new FakeShard()]]);
    this.guildShardMap = {};
    this.channelGuildMap = {};
    this.messages = [];
  }
  getChannel(id) { return this.guilds.get(GUILD).channels.get(id) || null; }
  joinVoiceChannel() { throw new Error("must not open an Eris voice connection"); }
  editStatus(status, activities) { presences.push({ status, activities }); }
  async createMessage(channel, text) { this.messages.push(text); }
  async getGateway() { throw new Error("REST blocked"); }
  async connect() { this.gateway = await this.getGateway(); }
  disconnect() {}
}

const realLoad = Module._load;
Module._load = function (request) {
  if (request === "eris") return FakeClient;
  if (request === "./keep_alive.js") return { setStatus() {} };
  return realLoad.apply(this, arguments);
};
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(" ")); if (process.env.VERBOSE) realLog(...a); };

Object.assign(process.env, {
  token: `  "${TOKEN}" `, // quotes + spaces must be stripped
  VOICE_CHANNEL_ID: VC,
  REJOIN_DELAY: "40",
  WATCHDOG_INTERVAL: "150",
  JOIN_CONFIRM_TIMEOUT: "120",
  PRESENCE_DEBOUNCE: "20",
  APPLICATION_ID: APP_ID,
  DATA_DIR,
});
require(path.join(__dirname, "..", "index.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const voice = (channel, session = "bot-session", extra = {}) =>
  client.emit("rawWS", {
    op: 0, t: "VOICE_STATE_UPDATE",
    d: { user_id: ME, guild_id: GUILD, channel_id: channel, session_id: session, self_mute: false, self_deaf: true, ...extra },
  }, 0);
const say = (content) => client.emit("messageCreate", { content, author: { id: ME }, channel: { id: "dm" } });
const last = () => sent[sent.length - 1];
const joinMsg = (channel) => ({ op: 4, d: { guild_id: GUILD, channel_id: channel, self_mute: false, self_deaf: true } });

(async () => {
  // 0. a failed gateway lookup is logged and falls back instead of hanging silently
  await sleep(10);
  assert.deepStrictEqual(client.gateway, { url: "wss://gateway.discord.gg" }, "falls back to default gateway");
  assert(logs.some((l) => l.includes("REST blocked")), "logs why the gateway lookup failed");

  // 1. joins on ready, mic on + deafened, through the gateway only
  client.ready = true;
  client.emit("ready");
  await sleep(10);
  assert.deepStrictEqual(sent, [joinMsg(VC)], "joins target VC on ready");
  voice(VC);
  await sleep(10);
  assert(logs.some((l) => l.includes("✅ Joined")), "logs the confirmed join");

  // 2. stays put: nothing more is sent while we're in the channel
  await sleep(350);
  assert.strictEqual(sent.length, 1, "no extra messages while sitting in VC");

  // 3. kicked -> rejoins
  voice(null);
  await sleep(80);
  assert.strictEqual(sent.length, 2, "rejoins after kick");
  assert.deepStrictEqual(last(), joinMsg(VC));
  voice(VC);
  await sleep(10);

  // 4. dragged to another channel -> goes back
  voice(VC2);
  await sleep(80);
  assert.strictEqual(sent.length, 3, "returns after being moved");
  assert.deepStrictEqual(last(), joinMsg(VC));
  voice(VC);
  await sleep(10);

  // 5. mute state gets changed -> mic on / deaf re-applied
  voice(VC, "bot-session", { self_mute: true });
  await sleep(20);
  assert.strictEqual(sent.length, 4, "re-applies mute/deaf");
  voice(VC);
  await sleep(10);

  // 6. user joins voice from their phone -> we don't fight it...
  voice(VC2, "phone-session");
  await sleep(400);
  assert.strictEqual(sent.length, 4, "does not fight another device");
  // ...and come back once the phone leaves
  voice(null, "phone-session");
  await sleep(80);
  assert.strictEqual(sent.length, 5, "rejoins when the other device leaves");
  assert.deepStrictEqual(last(), joinMsg(VC));

  // 7. Discord never confirms -> keeps retrying
  await sleep(450);
  assert(sent.length >= 7, "retries when the join is not confirmed");
  assert(logs.some((l) => l.includes("did not confirm")), "explains the unconfirmed join");
  voice(VC);
  await sleep(200);

  // 8. !leave pauses auto-rejoin
  let n = sent.length;
  say("!leave");
  await sleep(10);
  assert.deepStrictEqual(last(), joinMsg(null), "!leave sends a leave");
  voice(null);
  await sleep(400);
  assert.strictEqual(sent.length, n + 1, "no rejoin after !leave");

  // 9. !join <id> switches target and stays there
  say(`!join ${VC2}`);
  await sleep(10);
  assert.deepStrictEqual(last(), joinMsg(VC2), "!join switches target");
  voice(VC2);
  await sleep(10);
  voice(null);
  await sleep(80);
  assert.deepStrictEqual(last(), joinMsg(VC2), "rejoins the new target after kick");
  voice(VC2);
  await sleep(10);

  // 10. fresh gateway session (reconnect) -> joins again
  n = sent.length;
  client.emit("ready");
  await sleep(10);
  assert.strictEqual(sent.length, n + 1, "rejoins after a new session");
  voice(VC2, "bot-session-2");

  // 12. activity: custom status + card, with the saved total carried over
  await sleep(80);
  const shown = presences[presences.length - 1];
  assert.strictEqual(shown.status, "online");
  const custom = shown.activities.find((a) => a.type === 4);
  const card = shown.activities.find((a) => a.type === 5);
  const STOPWATCH = /^In VC for 02d-03h-05m-0\ds$/; // saved total 2d 3h 5m, plus the seconds of this test
  assert(STOPWATCH.test(custom.state), custom.state);
  assert.deepStrictEqual({ ...custom, state: "" }, { name: "Custom Status", type: 4, state: "", emoji: { name: "🎧" } });
  assert.strictEqual(card.application_id, APP_ID);
  assert.strictEqual(card.name, "My App", "card uses the application's name");
  assert.strictEqual(card.details, "Chilling in vc-444");
  assert(STOPWATCH.test(card.state), card.state);
  assert.deepStrictEqual(card.assets, { large_image: "777", large_text: "My App" }, "card uses the first uploaded image");
  const clockReads = Date.now() - card.timestamps.start;
  assert(Math.abs(clockReads - (51 * 60 + 5) * 60000) < 5000, "card clock ticks from the saved lifetime total (2d 3h 5m)");

  // 13. !timer and !activity
  say("!timer");
  await sleep(10);
  assert(/In VC for 0m this stay — 2d 3h in total/.test(client.messages[client.messages.length - 1]), "!timer reports stay + total");
  say("!activity grinding {channel}");
  await sleep(10);
  assert.strictEqual(presences[presences.length - 1].activities.find((a) => a.type === 4).state, "grinding vc-444");
  say("!activity off");
  await sleep(10);
  assert.deepStrictEqual(presences[presences.length - 1].activities, [], "!activity off clears it");
  say("!activity on");
  say("!activity reset");
  await sleep(10);
  assert(STOPWATCH.test(presences[presences.length - 1].activities.find((a) => a.type === 4).state), "reset restores the stopwatch text");

  // 14. out of VC: timer pauses, card loses its clock
  say("!leave");
  voice(null, "bot-session-2");
  await sleep(80);
  const idle = presences[presences.length - 1].activities;
  assert(/^Total VC time: 02d-03h-05m-0\ds$/.test(idle.find((a) => a.type === 4).state));
  assert(/^Total VC time: 02d-03h-05m-0\ds$/.test(idle.find((a) => a.type === 5).state));
  assert.strictEqual(idle.find((a) => a.type === 5).details, "Not in voice right now");
  assert(!idle.find((a) => a.type === 5).timestamps, "no elapsed clock when not in VC");
  const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "vc-timer.json"), "utf8"));
  assert(saved.totalMs >= (51 * 60 + 5) * 60000, "total is written to disk");
  assert.strictEqual(saved.customText, undefined, "reset removes the saved custom text");

  // 11. gateway errors are logged, and the token never is
  client.emit("error", new Error(`Invalid token: ${TOKEN}`), 0);
  assert(logs.some((l) => l.includes("Discord rejected the token")), "explains a rejected token");
  assert(!logs.some((l) => l.includes(TOKEN)), "token never appears in logs");

  realLog("ALL TESTS PASSED");
  process.exit(0);
})().catch((err) => {
  realLog(logs.slice(-15).join("\n"));
  realLog("TEST FAILED:", err.message);
  process.exit(1);
});
