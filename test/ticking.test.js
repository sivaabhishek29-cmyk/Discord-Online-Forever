// Offline test (real Eris, fake socket): while in VC the shown time is re-sent
// with advancing seconds, but never faster than Discord's limit of 5 status
// changes per 20 seconds. Run with: npm test (takes ~12s)
const assert = require("assert");
const h = require("./harness.js");

// Asking for 1s must be raised to the 5s floor.
h.start({ ACTIVITY_REFRESH: "1000", WATCHDOG_INTERVAL: "100000" });

const times = [];
const statusLine = () => {
  const acts = h.shownActivities() || [];
  const custom = acts.find((a) => a.type === 4);
  return custom ? custom.state : null;
};

h.finish("TICKING TEST", async () => {
  await h.until(() => h.socket() && h.sentOp(2).length === 1, "login");
  h.ready();
  await h.until(() => h.sentOp(4).length === 1, "join");
  h.voiceState(h.VC);
  await h.until(() => /^In VC for 00d-00h-00m-0\ds$/.test(statusLine() || ""), "stopwatch text");

  // Record when each status update goes out for ~11 seconds.
  let seen = h.sentOp(3).length;
  const first = statusLine();
  const end = Date.now() + 11000;
  while (Date.now() < end) {
    const n = h.sentOp(3).length;
    if (n > seen) { seen = n; times.push(Date.now()); }
    await h.sleep(50);
  }
  const last = statusLine();
  assert(times.length >= 2, `status re-sent while in VC (got ${times.length} updates)`);
  assert(times.length <= 3, `not faster than Discord allows (got ${times.length} updates in 11s)`);
  assert(times[1] - times[0] >= 4500, "updates are at least ~5s apart");
  assert.notStrictEqual(last, first, "the seconds advance");
  assert(/^In VC for 00d-00h-00m-(0[5-9]|1\d)s$/.test(last), `shows running seconds: ${last}`);
  const card = h.shownActivities().find((a) => a.application_id);
  assert.strictEqual(card.details, "Chilling with Alya 🩷🎀");
  assert.strictEqual(card.state, "dev Lovelycrxshx ♠");
  assert.deepStrictEqual(card.buttons, ["Self-run acc, not a real user", "Contact Admin"]);
  assert.deepStrictEqual(card.metadata.button_urls, ["https://discord.com/users/825998094067695616", "https://discord.com/users/825998094067695616"]);

  // Out of VC the stopwatch stops, and so do the updates.
  h.voiceState(null);
  await h.until(() => /^Total VC time: /.test(statusLine() || ""), "paused text");
  const paused = h.sentOp(3).length;
  await h.sleep(6000);
  assert.strictEqual(h.sentOp(3).length, paused, "no status updates while the stopwatch is paused");
});
