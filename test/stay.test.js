// Offline test: runs index.js against a fake Eris client (no Discord needed).
// Run with: npm test
const Module = require("module");
const EventEmitter = require("events");
const assert = require("assert");
const path = require("path");

const TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const ME = "111111111111111111";
const GUILD = "222222222222222222";
const VC = "333333333333333333";
const VC2 = "444444444444444444";

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
