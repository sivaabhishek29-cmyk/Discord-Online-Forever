// Shared test harness: the REAL Eris library + index.js, with only the network
// socket faked, so tests can replay what Discord sends a user account.
const Module = require("module");
const EventEmitter = require("events");
const path = require("path");
const fs = require("fs");
const os = require("os");

const TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const ME = "111111111111111111";
const GUILD = "222222222222222222";
const VC = "333333333333333333";

const sockets = [];
class FakeWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    sockets.push(this);
    setImmediate(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
      this.receive({ op: 10, d: { heartbeat_interval: 45000, _trace: [] } }); // HELLO
    });
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  receive(packet) { this.emit("message", Buffer.from(JSON.stringify(packet))); }
  // The connection drops from Discord's side.
  drop(code = 1006) { this.readyState = FakeWebSocket.CLOSED; this.emit("close", code, Buffer.from("")); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  terminate() { this.readyState = FakeWebSocket.CLOSED; }
}
Object.assign(FakeWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

const logs = [];
const realLog = console.log;

function start(env = {}) {
  const realLoad = Module._load;
  Module._load = function (request) {
    if (request === "ws") return FakeWebSocket;
    if (request === "./keep_alive.js") return { setStatus() {}, setLive() {} };
    return realLoad.apply(this, arguments);
  };
  console.log = (...a) => { logs.push(a.join(" ")); if (process.env.VERBOSE) realLog(...a); };

  const Eris = require("eris");
  Eris.Client.prototype.getGateway = async () => ({ url: "wss://gateway.test" });
  global.fetch = async () => { throw new Error("offline"); };

  Object.assign(process.env, {
    token: TOKEN,
    VOICE_CHANNEL_ID: VC,
    PRESENCE_DEBOUNCE: "20",
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "harness-")),
    ...env,
  });
  require(path.join(__dirname, "..", "index.js"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const socket = () => sockets[sockets.length - 1];
let seq = 0;
const dispatch = (t, d) => socket().receive({ op: 0, s: ++seq, t, d });
const lastSeq = () => seq;

function ready(sessionId = "gateway-session", extra = {}) {
  dispatch("READY", {
    v: 9,
    user: { id: ME, username: "me", discriminator: "0" },
    session_id: sessionId,
    resume_gateway_url: "wss://resume.test",
    user_settings: {},
    private_channels: [],
    guilds: [{
      id: GUILD, name: "Guild", member_count: 2, roles: [], members: [], voice_states: [],
      channels: [{ id: VC, type: 2, name: "Lounge", permission_overwrites: [] }],
    }],
    ...extra,
  });
}

const voiceState = (channelId, sessionId = "gateway-session", extra = {}) =>
  dispatch("VOICE_STATE_UPDATE", {
    user_id: ME, guild_id: GUILD, channel_id: channelId, session_id: sessionId,
    self_mute: false, self_deaf: true, mute: false, deaf: false, ...extra,
  });

// Every message index.js sent with this opcode, across reconnects.
const sentOp = (op) => sockets.flatMap((s) => s.sent).filter((p) => p.op === op);
const shownActivities = () => {
  const all = sentOp(3);
  return all.length ? all[all.length - 1].d.activities : null;
};

function finish(name, run) {
  run().then(
    () => { realLog(`${name} PASSED`); process.exit(0); },
    (err) => {
      realLog(logs.slice(-20).join("\n"));
      realLog(`${name} FAILED:`, err.message);
      process.exit(1);
    }
  );
}

module.exports = {
  TOKEN, ME, GUILD, VC, logs, sockets, socket, start, sleep, until, dispatch, lastSeq,
  ready, voiceState, sentOp, shownActivities, finish,
};
