// Offline end-to-end test: the REAL Eris library + index.js, with only the
// network socket faked. Replays what Discord sends a user account on login
// and checks the account ends up joining the voice channel.
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

let socket = null;
class FakeWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    socket = this;
    setImmediate(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
      this.receive({ op: 10, d: { heartbeat_interval: 45000, _trace: [] } }); // HELLO
    });
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  receive(packet) { this.emit("message", Buffer.from(JSON.stringify(packet))); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  terminate() { this.readyState = FakeWebSocket.CLOSED; }
  removeAllListeners() { return super.removeAllListeners(); }
}
Object.assign(FakeWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

const realLoad = Module._load;
Module._load = function (request) {
  if (request === "ws") return FakeWebSocket;
  if (request === "./keep_alive.js") return { setStatus() {} };
  return realLoad.apply(this, arguments);
};

const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(" ")); if (process.env.VERBOSE) realLog(...a); };

// No REST call to Discord during the test.
const Eris = require("eris");
Eris.Client.prototype.getGateway = async () => ({ url: "wss://gateway.test" });

global.fetch = async () => { throw new Error("offline"); }; // application lookup fails: must not matter
Object.assign(process.env, {
  token: TOKEN, VOICE_CHANNEL_ID: VC, JOIN_CONFIRM_TIMEOUT: "500", PRESENCE_DEBOUNCE: "20",
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "login-test-")),
});
require(path.join(__dirname, "..", "index.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, what, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for: ${what}`);
};

(async () => {
  await until(() => socket && socket.sent.some((p) => p.op === 2), "identify (login) to be sent");

  // What Discord sends a user account: full servers, including channel types
  // Eris 0.17 doesn't know (15 = forum). No GUILD_SYNC ever follows.
  socket.receive({
    op: 0, s: 1, t: "READY",
    d: {
      v: 9,
      user: { id: ME, username: "me", discriminator: "0" },
      session_id: "gateway-session",
      resume_gateway_url: "wss://resume.test",
      user_settings: {},
      private_channels: [],
      guilds: [{
        id: GUILD, name: "Guild", member_count: 2, roles: [], members: [], voice_states: [],
        channels: [
          { id: VC, type: 2, name: "Lounge", permission_overwrites: [] },
          { id: "555555555555555555", type: 15, name: "forum", permission_overwrites: [] },
        ],
      }],
    },
  });

  await until(() => logs.some((l) => l.includes("✅ Logged in as me")), "client to become ready after login");
  assert(!logs.some((l) => l.includes("forced ready")), "ready without needing the safety net");
  assert(!socket.sent.some((p) => p.op === 12), "never sends the obsolete guild-sync request");
  assert(!logs.some((l) => l.includes("Unknown guild text channel type")), "unknown channel types don't spam the log");

  await until(() => socket.sent.some((p) => p.op === 4), "voice join to be sent");
  assert.deepStrictEqual(
    socket.sent.find((p) => p.op === 4).d,
    { guild_id: GUILD, channel_id: VC, self_mute: false, self_deaf: true },
    "joins the target VC with mic on + deafened"
  );

  socket.receive({
    op: 0, s: 2, t: "VOICE_STATE_UPDATE",
    d: { user_id: ME, guild_id: GUILD, channel_id: VC, session_id: "gateway-session", self_mute: false, self_deaf: true, mute: false, deaf: false },
  });
  await until(() => logs.some((l) => l.includes("✅ Joined #Lounge")), "join to be confirmed");

  // The activity goes out over the real library as a presence update (op 3).
  await until(
    () => socket.sent.some((p) => p.op === 3 && p.d.activities.some((a) => a.type === 5 && a.timestamps)),
    "activity with the VC clock to be sent"
  );
  const presence = socket.sent.filter((p) => p.op === 3).pop().d;
  assert.strictEqual(presence.status, "online");
  assert.deepStrictEqual(presence.activities.map((a) => a.type), [4, 5], "custom status + 'Competing in' card");
  assert(/^In VC for 00d-00h-00m$/.test(presence.activities[0].state), presence.activities[0].state);
  assert.strictEqual(presence.activities[1].name, "Voice Chat", "falls back to a default name when the lookup fails");
  assert(!presence.activities[1].assets, "no image when the lookup fails");

  // Discord's own report of what the account shows is logged...
  const sessionsPacket = (activities) => ({
    op: 0, s: 3, t: "SESSIONS_REPLACE",
    d: [
      { session_id: "gateway-session", status: "online", client_info: { client: "unknown", os: "linux" }, activities },
      { session_id: "phone", status: "idle", client_info: { client: "mobile", os: "android" }, activities: [] },
    ],
  });
  socket.receive(sessionsPacket(presence.activities));
  await until(() => logs.some((l) => l.includes("Discord reports this account as") && l.includes("Competing in Voice Chat") && l.includes("[mobile/android] idle")), "session report in the log");
  assert(!logs.some((l) => l.includes("dropped the card")), "no warning when Discord kept the card");
  // ...and it says so when Discord kept only the status line,
  socket.receive(sessionsPacket(presence.activities.filter((a) => a.type === 4)));
  await until(() => logs.some((l) => l.includes("dropped the card")), "warning when Discord dropped the card");
  // ...or when the account's privacy setting hides the card.
  socket.receive({ op: 0, s: 4, t: "USER_SETTINGS_UPDATE", d: { show_current_game: false } });
  await until(() => logs.some((l) => l.includes("activity sharing switched OFF")), "privacy warning");

  assert(!logs.some((l) => l.includes(TOKEN)), "token never appears in logs");

  realLog("LOGIN TEST PASSED");
  process.exit(0);
})().catch((err) => {
  realLog(logs.slice(-15).join("\n"));
  realLog("LOGIN TEST FAILED:", err.message);
  process.exit(1);
});
