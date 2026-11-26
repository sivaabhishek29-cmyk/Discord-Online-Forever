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
h.start({
  DATA_DIR, CARD2_BAR: "level", CARD2_STATE: "Level {level} · Day {day}", LEVEL_TIME: "1:00:00",
  ACTIVITY_REFRESH: "5000", WATCHDOG_INTERVAL: "100000",
});

// Discord's public application pages: each card has its own application.
const APP1 = "1575262829869662312";
const APP2 = "1575297984684363846";
const lookedUp = [];
let pictureUploaded = false; // the second application's picture is uploaded later
const replies = [];
require("eris").Client.prototype.createMessage = async (channelId, content) => { replies.push(content); return { id: "1" }; };
let nextId = 9000;
const say = (content) =>
  h.dispatch("MESSAGE_CREATE", {
    id: String(++nextId), channel_id: "444444444444444444", content, type: 0, timestamp: new Date().toISOString(),
    author: { id: h.ME, username: "me", discriminator: "0" },
    mentions: [], mention_roles: [], attachments: [], embeds: [],
  });
// Day 1 is 26 November 2026, India time; the number goes up at each India midnight.
const indiaDay = (ms) => Math.floor((ms + 5.5 * 3600000) / 86400000);
const today = () => Math.max(1, indiaDay(Date.now()) - indiaDay(Date.UTC(2026, 10, 26, 0, 0)) + 1);
global.fetch = async (url) => {
  lookedUp.push(String(url));
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  if (url.includes(`/applications/${APP1}/rpc`)) return json({ name: "Main App" });
  if (url.includes(`/applications/${APP2}/rpc`)) return json({ name: "Shark App" });
  if (url.includes(`/applications/${APP2}/assets`)) return json(pictureUploaded ? [{ id: "900", name: "shark" }] : []);
  return json([]);
};

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
  await h.until(() => cards().length === 2 && cards()[1].name === "Shark App", "two cards on the profile");
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

  assert.strictEqual(first.name, "Main App");
  assert.strictEqual(first.application_id, APP1);

  // Card 2: its own application (name + picture), level 3, bar one hour long and 59:56 in.
  assert.strictEqual(second.type, 2);
  assert.strictEqual(second.application_id, APP2);
  assert.strictEqual(second.name, "Shark App");
  assert.strictEqual(second.details, "Activity Intervel 🦈");
  assert.strictEqual(second.state, `Level 3 · Day ${today()}`);
  assert(lookedUp.every((u) => u.startsWith("https://discord.com/api/")), "only Discord's public pages are read");

  // No picture uploaded yet: the card goes out without one, and the log says why.
  assert(!("assets" in second), "no picture yet");
  assert(h.logs.some((l) => l.includes('🖼️ card 2: application "Shark App" has no Rich Presence pictures')), "says the picture is missing");

  // The picture is uploaded afterwards → !reload picks it up, no restart needed.
  pictureUploaded = true;
  say("!reload");
  await h.until(() => replies.some((r) => r.includes('🖼️ card 2: application "Shark App", picture "shark"') && r.endsWith("Cards sent again.")), "!reload reply");
  await h.until(() => cards().length === 2 && cards()[1].assets, "picture on card 2", 8000);
  assert.deepStrictEqual(cards()[1].assets, { large_image: "900", large_text: "Shark App" });
  assert.deepStrictEqual(cards()[1].timestamps, second.timestamps, "the bar carries on where it was");

  // Day counter: !day shows it, !day 5 makes today day 5.
  say("!day");
  await h.until(() => replies.some((r) => r.startsWith(`Today is day ${today()}. Day 1 was `)), "!day reply");
  say("!day 5");
  await h.until(() => replies.some((r) => r.startsWith("Today is day 5. Day 1 was ")), "!day 5 reply");
  await h.until(() => cards().length === 2 && /· Day 5$/.test(cards()[1].state), "day 5 on the card", 8000);
  say("!day zero");
  await h.until(() => replies.some((r) => r.startsWith("Usage: !day 5")), "bad day reply");
  assert.strictEqual(second.timestamps.end - second.timestamps.start, HOUR);
  const into = joinedAt - second.timestamps.start;
  assert(Math.abs(into - (HOUR - 4000)) < 1500, `bar starts 59:56 in (got ${into}ms)`);
  assert(h.logs.some((l) => /card "Listening to Shark App" — Activity Intervel 🦈 \/ Level 3 · Day \d+ .*bar 1h 0m long/.test(l)), "the second card is logged");

  // Discord's own report: both cards → quiet; only one → a clear warning.
  SESSIONS([{ type: 4, name: "Custom Status", state: "x" }, { type: 5, name: "App", application_id: "1" }, { type: 2, name: "Lounge" }]);
  await h.sleep(50);
  assert(!h.logs.some((l) => l.includes("cards that were sent")), "no warning while both cards show");
  SESSIONS([{ type: 4, name: "Custom Status", state: "x" }, { type: 5, name: "App", application_id: "1" }]);
  await h.until(() => h.logs.some((l) => l.includes("Discord is showing 1 of the 2 cards that were sent. Check that CARD2_APPLICATION_ID")), "dropped-card warning");

  // The level finishes: number goes up and the bar starts again where it ended.
  await h.until(() => cards().length === 2 && /^Level 4 · /.test(cards()[1].state), "level up", 12000);
  assert.strictEqual(cards()[1].details, "Activity Intervel 🦈");
  assert.strictEqual(cards()[1].timestamps.start, second.timestamps.end);
  assert.strictEqual(cards()[1].timestamps.end - cards()[1].timestamps.start, HOUR);
  assert.deepStrictEqual(cards()[0].timestamps, first.timestamps, "card 1 is not disturbed by a level up");

  // Out of voice: the bar card goes (it cannot be paused); card 1 keeps the time.
  h.voiceState(null);
  await h.until(() => h.logs.some((l) => /Activity set .*Not in voice right now/.test(l) && !/Listening to/.test(l.split("Not in voice")[1] || "")), "one card out of voice");
});
