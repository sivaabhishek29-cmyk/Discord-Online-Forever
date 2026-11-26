// Unit tests for the VC timer file and the activity builder. Run with: npm test
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createVcTimer, formatDuration, formatStopwatch } = require("../vc_timer.js");
const { parseWhen, cleanButtons, buildActivities, pickAsset, fill, describeSessions, cleanStreamUrl } = require("../activity.js");

const MIN = 60000;
const HOUR = 60 * MIN;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timer-test-"));
const file = path.join(dir, "nested", "vc-timer.json");
let clock = 1_000_000;
const now = () => clock;

// formatting
assert.strictEqual(formatDuration(0), "0m");
assert.strictEqual(formatDuration(59 * MIN + 59000), "59m");
assert.strictEqual(formatDuration(5 * HOUR + 12 * MIN), "5h 12m");
assert.strictEqual(formatDuration(52 * HOUR + 30 * MIN), "2d 4h");
assert.strictEqual(formatStopwatch(0), "00d-00h-00m-00s");
assert.strictEqual(formatStopwatch(((9 * 24 + 14) * 60 + 47) * MIN + 54999, false), "09d-14h-47m");
assert.strictEqual(formatStopwatch(((9 * 24 + 14) * 60 + 47) * MIN + 54999), "09d-14h-47m-54s");
assert.strictEqual(formatStopwatch(123 * 24 * HOUR + 1000), "123d-00h-00m-01s");

// counts only between start and stop
let t = createVcTimer({ file, now });
assert.strictEqual(t.loaded, false);
t.start();
clock += 2 * HOUR;
assert.strictEqual(t.totalMs(), 2 * HOUR);
assert.strictEqual(t.stayMs(), 2 * HOUR);
assert.strictEqual(t.totalStart(), clock - 2 * HOUR, "clock start reads the total");
t.stop();
clock += 10 * HOUR; // out of VC: not counted
assert.strictEqual(t.totalMs(), 2 * HOUR);
assert.strictEqual(t.totalStart(), null, "no clock while out of VC");
t.set("customText", "hello");

// "restart": a new timer on the same file carries the total and settings over
t.start();
assert.strictEqual(t.totalStart(), clock - 2 * HOUR, "a new stay continues the same total");
const steady = t.totalStart();
clock += 30 * MIN;
assert.strictEqual(t.totalStart(), steady, "clock start does not move during a stay");
t.save(); // periodic save while still in VC, then the process dies
t = createVcTimer({ file, now });
assert.strictEqual(t.loaded, true);
assert.strictEqual(t.totalMs(), 2 * HOUR + 30 * MIN, "total survives a restart");
assert.strictEqual(t.get("customText"), "hello", "settings survive a restart");
assert.strictEqual(t.running(), false, "a restart begins outside VC");

// a corrupt file is set aside, not fatal
fs.writeFileSync(file, "{not json");
const errors = [];
t = createVcTimer({ file, now, onError: (e) => errors.push(e) });
assert.strictEqual(t.totalMs(), 0);
assert.strictEqual(errors.length, 1);
assert(fs.existsSync(`${file}.bad`), "corrupt file is kept as .bad");

// an unwritable location reports failure instead of throwing
const plainFile = path.join(dir, "plain.txt");
fs.writeFileSync(plainFile, "x");
const blocked = createVcTimer({ file: path.join(plainFile, "sub", "vc-timer.json"), now, onError: () => {} });
assert.strictEqual(blocked.save(), false);

// activity builder
assert.strictEqual(fill("a {total} {nope}", { total: "1h" }), "a 1h {nope}");
assert.strictEqual(pickAsset([], "x"), null);
assert.strictEqual(pickAsset([{ id: "1", name: "a" }, { id: "2", name: "Logo" }], "logo").id, "2");
assert.strictEqual(pickAsset([{ id: "1", name: "a" }, { id: "2", name: "b" }], "missing").id, "1");

const cfg = {
  mode: "both", appId: "42", appName: null, imageId: null,
  customText: "In VC for {total}", customTextIdle: "Total VC time: {total}", customEmoji: "",
  details: "Chilling in {channel}", detailsIdle: "Not in voice right now", state: "Total VC time: {total}",
};
const state = { inVoice: true, channelName: "General", total: "3h 1m", stay: "5m", stayStart: 123 };
assert.deepStrictEqual(buildActivities(cfg, state), [
  { name: "Custom Status", type: 4, state: "In VC for 3h 1m" },
  { name: "Voice Chat", type: 5, application_id: "42", details: "Chilling in General", state: "Total VC time: 3h 1m", timestamps: { start: 123 } },
]);
assert.deepStrictEqual(buildActivities(cfg, { ...state, totalStart: 7 })[1].timestamps, { start: 7 }, "clock counts the lifetime total");
assert.deepStrictEqual(buildActivities({ ...cfg, clock: "stay" }, { ...state, totalStart: 7 })[1].timestamps, { start: 123 }, "or only the current stay");
assert.deepStrictEqual(buildActivities({ ...cfg, mode: "custom" }, state).map((a) => a.type), [4]);
assert.deepStrictEqual(buildActivities({ ...cfg, mode: "rich" }, state).map((a) => a.type), [5], "competing by default");
assert.deepStrictEqual(buildActivities({ ...cfg, mode: "rich", cardType: 3 }, state).map((a) => a.type), [3]);
assert.deepStrictEqual(buildActivities({ ...cfg, mode: "off" }, state), []);
assert.deepStrictEqual(buildActivities({ ...cfg, appId: null }, state).map((a) => a.type), [4], "no card without an application");
assert(buildActivities({ ...cfg, customText: "x".repeat(300) }, state)[0].state.length <= 128, "text is clipped to Discord's limit");

// purple dot: a "Streaming" entry with a Twitch or YouTube link, added last
{
  const stream = { url: "https://www.twitch.tv/discord", title: "Live 24/7 🔴 {channel}" };
  const acts = buildActivities({ ...cfg, stream }, state);
  const plain = buildActivities(cfg, state);
  assert.deepStrictEqual(acts.slice(0, -1), plain, "the other entries are untouched");
  assert.deepStrictEqual(acts[acts.length - 1], {
    name: "Twitch", type: 1, url: "https://www.twitch.tv/discord", details: `Live 24/7 🔴 ${state.channelName || "voice"}`,
  });
  assert.strictEqual(buildActivities({ ...cfg, stream: { url: "https://youtube.com/watch?v=abc", title: "" } }, state).pop().name, "YouTube");
  assert(!("details" in buildActivities({ ...cfg, stream: { url: "https://twitch.tv/x", title: "" } }, state).pop()), "an empty title is left out");
  assert(!buildActivities({ ...cfg, stream: { url: "https://example.com/x", title: "t" } }, state).some((a) => a.type === 1), "other sites cannot turn the dot purple");
  assert.deepStrictEqual(buildActivities({ ...cfg, mode: "off", stream }, state), []);
  assert.deepStrictEqual(buildActivities({ ...cfg, mode: "custom", stream }, state).map((a) => a.type), [4, 1]);
  assert.strictEqual(cleanStreamUrl(" https://www.twitch.tv/discord "), "https://www.twitch.tv/discord");
  for (const bad of ["", "twitch.tv/x", "http://twitch.tv/x", "https://twitch.tv/", "https://twitch.tv.evil.com/x", "https://nottwitch.tv/x", "https://twitch.tv/a b"]) {
    assert.strictEqual(cleanStreamUrl(bad), null, bad);
  }
}

// what Discord reports back, summarised
assert.deepStrictEqual(
  describeSessions(
    [
      { session_id: "all", status: "online", activities: [] },
      { session_id: "mine", status: "online", activities: [{ type: 4, name: "Custom Status", state: "In VC for 5m" }, { type: 5, name: "My App", application_id: "42" }] },
      { session_id: "phone", status: "idle", client_info: { client: "mobile", os: "android" }, activities: [] },
    ],
    "mine"
  ),
  ['[this app] online: status "In VC for 5m" + Competing in My App', "[mobile/android] idle: no activity"]
);

console.log("TIMER TESTS PASSED");

// Buttons: labels and links go out as two lists; unusable ones are dropped.
{
  const build = buildActivities;
  const clean = cleanButtons;
  const base = { mode: "rich", appId: "42", details: "a", detailsIdle: "b", state: "c" };
  const st = { inVoice: true, total: "1m", stay: "1m" };
  const withButtons = build({ ...base, buttons: [{ label: "contact dev", url: "https://discord.com/users/1" }, null] }, st)[0];
  assert.deepStrictEqual(withButtons.buttons, ["contact dev"]);
  assert.deepStrictEqual(withButtons.metadata, { button_urls: ["https://discord.com/users/1"] });
  const none = build({ ...base, buttons: [null, { label: "x", url: "not a link" }] }, st)[0];
  assert(!("buttons" in none) && !("metadata" in none), "no button fields when there is nothing to show");
  assert.strictEqual(clean([{ label: "L".repeat(40), url: "https://a.b" }])[0].label.length, 32);
  assert.strictEqual(clean([1, 2, 3].map((n) => ({ label: `b${n}`, url: "https://a.b" }))).length, 2);
  console.log("BUTTON TESTS PASSED");
}

// Countdown: an end time replaces the count-up clock, in or out of voice.
{
  const base = { mode: "rich", appId: "42", details: "a", detailsIdle: "b", state: "c" };
  const up = buildActivities(base, { inVoice: true, total: "1m", stay: "1m", stayStart: 5, totalStart: 3 })[0];
  assert.deepStrictEqual(up.timestamps, { start: 3 });
  const down = buildActivities(base, { inVoice: true, total: "1m", stay: "1m", stayStart: 5, totalStart: 3, countdownEnd: 999 })[0];
  assert.deepStrictEqual(down.timestamps, { end: 999 });
  const idle = buildActivities(base, { inVoice: false, total: "1m", stay: "1m", countdownEnd: 999 })[0];
  assert.deepStrictEqual(idle.timestamps, { end: 999 }, "the countdown shows out of voice too");

  // Dates are read day-first or year-first, in India time unless a zone is given.
  const iso = (text, offset) => { const ms = parseWhen(text, offset); return ms === null ? null : new Date(ms).toISOString(); };
  assert.strictEqual(iso("31-12-2026 23:59"), "2026-12-31T18:29:00.000Z");
  assert.strictEqual(iso("31/12/2026 11:59 pm"), "2026-12-31T18:29:00.000Z");
  assert.strictEqual(iso("31-12-2026, 9:05 AM"), "2026-12-31T03:35:00.000Z");
  assert.strictEqual(iso("1.1.2027 12:00 am"), "2026-12-31T18:30:00.000Z");
  assert.strictEqual(iso("2026-12-31"), "2026-12-30T18:30:00.000Z");
  assert.strictEqual(iso("2026-12-31T23:59+05:30"), "2026-12-31T18:29:00.000Z");
  assert.strictEqual(iso("2026-12-31 18:29Z"), "2026-12-31T18:29:00.000Z");
  assert.strictEqual(iso("31-12-2026 23:59", "+00:00"), "2026-12-31T23:59:00.000Z");
  for (const bad of ["soon", "", "31-02-2026", "2026-13-01", "2026-12-31 25:00", "31-12-2026 13:00 pm", "12-31-2026"]) {
    assert.strictEqual(iso(bad), null, `"${bad}" is not a date`);
  }
  console.log("COUNTDOWN TESTS PASSED");
}

// Time-of-day clock and the second card with its self-moving level bar.
{
  const HOUR = 3600000;
  const base = { mode: "both", appId: "42", customText: "x", customTextIdle: "y", details: "a", detailsIdle: "b", state: "c" };
  const st = { inVoice: true, total: "1m", stay: "1m", stayStart: 5000, totalStart: 3000, dayStart: 1000, channelName: "General" };

  const timeCard = buildActivities({ ...base, clock: "time" }, st)[1];
  assert.deepStrictEqual(timeCard.timestamps, { start: 1000 }, "clock started at local midnight");
  assert.deepStrictEqual(buildActivities({ ...base, clock: "time" }, { ...st, inVoice: false })[1].timestamps, { start: 1000 }, "time of day shows out of voice too");
  assert.deepStrictEqual(buildActivities({ ...base, clock: "time" }, { ...st, countdownEnd: 9 })[1].timestamps, { end: 9 }, "a countdown wins over the time of day");

  const card2 = { type: 2, name: "{channel}", details: "Voice level {level}", state: "New level every 24h in voice", levelMs: 24 * HOUR };
  // 9 days 14h 47m 54s of voice so far → level 10, bar 14:47:54 into 24:00:00.
  const total = 9 * 24 * HOUR + 14 * HOUR + 47 * 60000 + 54000;
  const now = 1_800_000_000_000;
  const acts = buildActivities({ ...base, card2 }, { ...st, totalMs: total, totalStart: now - total });
  assert.strictEqual(acts.length, 3, "status line + two cards");
  const bar = acts[2];
  assert.deepStrictEqual(
    { ...bar, timestamps: undefined },
    { name: "General", type: 2, details: "Voice level 10", state: "New level every 24h in voice", timestamps: undefined }
  );
  assert.strictEqual(now - bar.timestamps.start, 14 * HOUR + 47 * 60000 + 54000, "bar position = time into this level");
  assert.strictEqual(bar.timestamps.end - bar.timestamps.start, 24 * HOUR, "bar length = one level");
  assert(!("application_id" in bar), "no application needed for the bar card");
  assert.strictEqual(acts[1].application_id, "42", "the first card is untouched");

  // Start and end stay put for the whole level, so nothing has to be re-sent.
  const later = buildActivities({ ...base, card2 }, { ...st, totalMs: total + HOUR, totalStart: now - total })[2];
  assert.deepStrictEqual(later.timestamps, bar.timestamps);
  // Level up: next number, bar starts again from zero.
  const next = buildActivities({ ...base, card2 }, { ...st, totalMs: 10 * 24 * HOUR + 1000, totalStart: now - total })[2];
  assert.strictEqual(next.details, "Voice level 11");
  assert.strictEqual(next.timestamps.start, bar.timestamps.end);

  assert.strictEqual(buildActivities({ ...base, card2 }, { ...st, inVoice: false, totalMs: total, totalStart: null }).length, 2, "no bar outside voice");
  assert.strictEqual(buildActivities({ ...base, mode: "custom", card2 }, { ...st, totalMs: total }).length, 1, "status-only mode has no cards");
  assert.strictEqual(buildActivities({ ...base, mode: "off", card2 }, { ...st, totalMs: total }).length, 0);
  const watching = buildActivities({ ...base, card2: { ...card2, type: 3, appId: "77" } }, { ...st, totalMs: 0 })[2];
  assert.strictEqual(watching.type, 3);
  assert.strictEqual(watching.application_id, "77");
  assert.strictEqual(watching.details, "Voice level 1");
  // An empty line is left out; a picture needs the card's own application.
  const bare = buildActivities({ ...base, card2: { ...card2, details: "Active Intervel 🦈", state: "", imageId: "9" } }, { ...st, totalMs: 0 })[2];
  assert.strictEqual(bare.details, "Active Intervel 🦈");
  assert(!("state" in bare) && !("assets" in bare));
  const pictured = buildActivities({ ...base, card2: { ...card2, name: "Shark", appId: "77", imageId: "9" } }, { ...st, totalMs: 0 })[2];
  assert.deepStrictEqual(pictured.assets, { large_image: "9", large_text: "Shark" });
  // The exact day: 23:56:04 long, so 14:47:54 in leaves 09:08:10 to go.
  const exact = ((23 * 60 + 56) * 60 + 4) * 1000;
  const into = ((14 * 60 + 47) * 60 + 54) * 1000;
  const day = buildActivities({ ...base, card2: { ...card2, levelMs: exact } }, { ...st, totalMs: 3 * exact + into, totalStart: now - (3 * exact + into) })[2];
  assert.strictEqual(day.details, "Voice level 4");
  assert.strictEqual(now - day.timestamps.start, into);
  assert.strictEqual(day.timestamps.end - day.timestamps.start, exact);
  // Clock bar: starts at local midnight whatever the voice time is, and stays
  // on the profile outside voice.
  const clockBar = { ...card2, bar: "time", levelMs: exact };
  const inVc = buildActivities({ ...base, card2: clockBar }, { ...st, dayStart: 5000, totalMs: 3 * exact + into, totalStart: now - 1 })[2];
  assert.deepStrictEqual(inVc.timestamps, { start: 5000, end: 5000 + exact });
  assert.strictEqual(inVc.details, "Voice level 4", "the level still counts voice time");
  const outOfVc = buildActivities({ ...base, card2: clockBar }, { ...st, inVoice: false, dayStart: 5000, totalMs: into, totalStart: null });
  assert.strictEqual(outOfVc.length, 3, "the clock bar shows out of voice too");
  assert.deepStrictEqual(outOfVc[2].timestamps, { start: 5000, end: 5000 + exact });
  assert.strictEqual(buildActivities({ ...base, card2: clockBar }, { ...st, dayStart: null, totalMs: 0 }).length, 2, "no bar without a day start");
  // {day} in the text.
  const dayCard = buildActivities({ ...base, card2: { ...clockBar, state: "Day {day}" } }, { ...st, dayStart: 5000, day: 12, totalMs: 0 })[2];
  assert.strictEqual(dayCard.state, "Day 12");
  console.log("TWO-CARD TESTS PASSED");
}
