// Offline test (real Eris, fake socket) of what the profile shows by default:
// card 1 with a clock that reads India time, card 2 with a level bar that
// Discord moves by itself. Run with: npm test (takes ~10s)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const h = require("./harness.js");

const HOUR = 3600000;
// One-hour levels, and a saved total 4 seconds short of finishing level 3.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cards-test-"));
fs.writeFileSync(path.join(DATA_DIR, "vc-timer.json"), JSON.stringify({ totalMs: 3 * HOUR - 4000 }));
h.start({ DATA_DIR, LEVEL_HOURS: "1", ACTIVITY_REFRESH: "5000", WATCHDOG_INTERVAL: "100000" });

const cards = () => (h.shownActivities() || []).filter((a) => a.type !== 4);
const SESSIONS = (activities) => h.dispatch("SESSIONS_REPLACE", [
  { session_id: "gateway-session", status: "online", client_info: { client: "web", os: "linux" }, activities },
]);

h.finish("CARDS TEST", async () => {
  await h.until(() => h.socket() && h.sentOp(2).length === 1, "login");
  h.ready();
  await h.until(() => h.sentOp(4).length === 1, "join");
  const joinedAt = Date.now();
  h.voiceState(h.VC);
  await h.until(() => cards().length === 2, "two cards on the profile");
  const [first, second] = cards();

  // Card 1: your lines, and a clock started at midnight India time (UTC+05:30).
  assert.strictEqual(first.type, 5);
  assert.strictEqual(first.details, "Chilling with Alya 🩷🎀");
  assert.strictEqual(first.state, "dev Lovelycrxshx ♠");
  assert.deepStrictEqual(Object.keys(first.timestamps), ["start"]);
  const india = new Date(Date.now() + 5.5 * HOUR);
  const sinceMidnight = ((india.getUTCHours() * 60 + india.getUTCMinutes()) * 60 + india.getUTCSeconds()) * 1000;
  const reads = Date.now() - first.timestamps.start;
  assert(Math.abs(reads - sinceMidnight) < 2000, `clock reads India time of day (off by ${reads - sinceMidnight}ms)`);
  assert.deepStrictEqual(first.buttons, ["Self-run acc, not a real user", "Contact Admin"]);

  // Card 2: "Listening to <channel>", level 3, bar one hour long and 59:56 in.
  assert.strictEqual(second.type, 2);
  assert.strictEqual(second.name, "Lounge");
  assert.strictEqual(second.details, "Voice level 3");
  assert.strictEqual(second.state, "New level every 1h in voice");
  assert.strictEqual(second.timestamps.end - second.timestamps.start, HOUR);
  const into = joinedAt - second.timestamps.start;
  assert(Math.abs(into - (HOUR - 4000)) < 1500, `bar starts 59:56 in (got ${into}ms)`);
  assert(h.logs.some((l) => /card "Listening to Lounge" — Voice level 3 .*bar 1h 0m long/.test(l)), "the second card is logged");

  // Discord's own report: both cards → quiet; only one → a clear warning.
  SESSIONS([{ type: 4, name: "Custom Status", state: "x" }, { type: 5, name: "App", application_id: "1" }, { type: 2, name: "Lounge" }]);
  await h.sleep(50);
  assert(!h.logs.some((l) => l.includes("cards that were sent")), "no warning while both cards show");
  SESSIONS([{ type: 4, name: "Custom Status", state: "x" }, { type: 5, name: "App", application_id: "1" }]);
  await h.until(() => h.logs.some((l) => l.includes("Discord is showing 1 of the 2 cards that were sent. Set CARD2=off")), "dropped-card warning");

  // The level finishes: number goes up and the bar starts again where it ended.
  await h.until(() => cards().length === 2 && cards()[1].details === "Voice level 4", "level up", 12000);
  assert.strictEqual(cards()[1].timestamps.start, second.timestamps.end);
  assert.strictEqual(cards()[1].timestamps.end - cards()[1].timestamps.start, HOUR);
  assert.deepStrictEqual(cards()[0].timestamps, first.timestamps, "card 1 is not disturbed by a level up");

  // Out of voice: the bar card goes (it cannot be paused); card 1 keeps the time.
  h.voiceState(null);
  await h.until(() => h.logs.some((l) => /Activity set .*Not in voice right now/.test(l) && !/Listening to/.test(l.split("Not in voice")[1] || "")), "one card out of voice");
});
