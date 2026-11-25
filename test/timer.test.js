// Unit tests for the VC timer file and the activity builder. Run with: npm test
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createVcTimer, formatDuration } = require("../vc_timer.js");
const { buildActivities, pickAsset, fill } = require("../activity.js");

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

// counts only between start and stop
let t = createVcTimer({ file, now });
assert.strictEqual(t.loaded, false);
t.start();
clock += 2 * HOUR;
assert.strictEqual(t.totalMs(), 2 * HOUR);
assert.strictEqual(t.stayMs(), 2 * HOUR);
t.stop();
clock += 10 * HOUR; // out of VC: not counted
assert.strictEqual(t.totalMs(), 2 * HOUR);
t.set("customText", "hello");

// "restart": a new timer on the same file carries the total and settings over
t.start();
clock += 30 * MIN;
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
  { name: "Voice Chat", type: 0, application_id: "42", details: "Chilling in General", state: "Total VC time: 3h 1m", timestamps: { start: 123 } },
]);
assert.deepStrictEqual(buildActivities({ ...cfg, mode: "custom" }, state).map((a) => a.type), [4]);
assert.deepStrictEqual(buildActivities({ ...cfg, mode: "rich" }, state).map((a) => a.type), [0]);
assert.deepStrictEqual(buildActivities({ ...cfg, mode: "off" }, state), []);
assert.deepStrictEqual(buildActivities({ ...cfg, appId: null }, state).map((a) => a.type), [4], "no card without an application");
assert(buildActivities({ ...cfg, customText: "x".repeat(300) }, state)[0].state.length <= 128, "text is clipped to Discord's limit");

console.log("TIMER TESTS PASSED");
