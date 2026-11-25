// Virtual pet: the rules on their own, then the whole app (real Eris, fake
// socket) answering DMs and showing the pet on the status line.
// Run with: npm test
const assert = require("assert");
const { createPet, petAction, createLimiter, parseSleep } = require("../pet.js");

const HOUR = 3600000;
// 2026-01-01 06:30 UTC = 12:00 in India.
const NOON_IST = Date.UTC(2026, 0, 1, 6, 30);

{
  let t = NOON_IST;
  let stored = null;
  const make = (extra = {}) => createPet({ load: () => stored, save: (s) => { stored = s; }, now: () => t, ...extra });
  let pet = make();
  assert.deepStrictEqual(pet.mood(), { key: "happy", face: "😺", text: "Mochi is happy ♥♥♥♡♡" });
  assert(stored, "a new pet is saved straight away");

  // Hunger grows with time: 60% food lasts 7.2h of a 12h tank.
  t += 3 * HOUR; // 15:00 — food 35, fun 22.5
  assert.strictEqual(pet.mood().key, "hungry");
  assert.strictEqual(pet.mood().face, "😿");
  assert(/^Mochi is hungry ♥♡♡♡♡ · DM me: feed$/.test(pet.mood().text), pet.mood().text);
  assert(/^🍖 Yum! Mochi's food is now 70%/.test(pet.feed()));
  assert.strictEqual(pet.mood().key, "bored");
  assert(/DM me: play$/.test(pet.mood().text));
  assert(/fun is now 6[23]%/.test(pet.play()), "play raises fun by 40");
  assert.strictEqual(pet.mood().key, "happy");
  pet.feed();
  assert(/is full already/.test(pet.feed()), "cannot overfeed");
  pet.play();
  assert(/played enough/.test(pet.play()));
  assert.strictEqual(pet.mood().key, "very happy");
  assert.strictEqual(pet.mood().face, "😻");
  assert(/^💗 Mochi purrs\.$/.test(pet.pat()));
  assert(/^😻 Mochi is very happy — food 100%, fun 100%, age 0 days, fed 2×, played 2×\.$/.test(pet.stats()), pet.stats());

  // Night (23:00–07:00 India time): asleep, nothing drains, no feeding.
  t = Date.UTC(2026, 0, 1, 17, 30); // 23:00 IST — 8h awake since 15:00
  const beforeNight = pet.state();
  assert.strictEqual(pet.mood().key, "sleeping");
  assert.strictEqual(pet.mood().face, "😴");
  assert(/sleeping 💤 Come back after 07:00/.test(pet.feed()));
  t += 8 * HOUR; // 07:00 IST
  const afterNight = pet.state();
  assert(Math.abs(afterNight.food - beforeNight.food) < 1.5, "food does not drain while asleep");
  assert.notStrictEqual(pet.mood().key, "sleeping");

  // Survives a restart, including a rename.
  assert.strictEqual(pet.rename("  Luna   Moon "), true);
  assert.strictEqual(pet.rename("   "), false);
  const snapshot = JSON.parse(JSON.stringify(stored));
  stored = snapshot;
  pet = make();
  assert.strictEqual(pet.name(), "Luna Moon");
  assert.strictEqual(pet.state().fed, 2);
  assert(Math.abs(pet.state().food - afterNight.food) < 0.01, "stats carry over a restart");

  // A long time off: starving, never negative, and no slow catch-up.
  t += 400 * 24 * HOUR;
  const started = Date.now();
  assert.strictEqual(pet.state().food, 0);
  assert(Date.now() - started < 500, "catch-up after a long break is quick");
  t = Date.UTC(2027, 1, 10, 6, 30);
  assert.strictEqual(pet.mood().key, "starving");
  assert.strictEqual(pet.mood().face, "🙀");

  // Options: fixed face, never sleeps, broken saved data, bad time zone.
  stored = null;
  t = Date.UTC(2026, 0, 1, 20, 0); // 01:30 IST
  assert.strictEqual(make({ emoji: "🐶", sleep: "0-0" }).mood().face, "🐶");
  stored = { food: "lots" };
  assert.strictEqual(make({ sleep: "0-0" }).state().food, 60, "nonsense on disk starts a new pet");
  stored = null;
  assert.doesNotThrow(() => make({ timeZone: "Not/AZone" }).mood());
  assert.deepStrictEqual(parseSleep("22-6"), { from: 22, to: 6 });
  assert.deepStrictEqual(parseSleep("nonsense"), { from: 23, to: 7 });
}

// Only a single known word counts.
assert.strictEqual(petAction(" Feed! "), "feed");
assert.strictEqual(petAction("!play"), "play");
assert.strictEqual(petAction("pet"), "pat");
assert.strictEqual(petAction("status"), "stats");
assert.strictEqual(petAction("feed me please"), null);
assert.strictEqual(petAction("constructor"), null);
assert.strictEqual(petAction(""), null);

{
  let t = 0;
  const allow = createLimiter({ perUserMs: 2000, maxPerMinute: 3, now: () => t });
  assert.strictEqual(allow("a"), true);
  assert.strictEqual(allow("a"), false, "same person too fast");
  assert.strictEqual(allow("b"), true);
  assert.strictEqual(allow("c"), true);
  assert.strictEqual(allow("d"), false, "total per minute reached");
  t = 61000;
  assert.strictEqual(allow("d"), true);
}
console.log("PET RULES PASSED");

// --- The whole app ----------------------------------------------------------
const h = require("./harness.js");
h.start({ PET: "on", PET_SLEEP: "0-0", WATCHDOG_INTERVAL: "100000" });

const DM = "444444444444444444";
const FRIEND = "555555555555555555";
const STRANGER = "666666666666666666";
let nextId = 9000;
const message = (author, content, extra = {}) =>
  h.dispatch("MESSAGE_CREATE", {
    id: String(++nextId), channel_id: DM, content, type: 0, timestamp: new Date().toISOString(),
    author: { id: author, username: `user-${author.slice(0, 3)}`, discriminator: "0" },
    mentions: [], mention_roles: [], attachments: [], embeds: [], ...extra,
  });
const custom = () => (h.shownActivities() || []).find((a) => a.type === 4) || {};
const lastReply = () => h.messages[h.messages.length - 1];

h.finish("PET TEST", async () => {
  await h.until(() => h.socket() && h.sentOp(2).length === 1, "login");
  h.ready("gateway-session", {
    private_channels: [{ id: DM, type: 1, recipients: [{ id: FRIEND, username: "friend", discriminator: "0" }] }],
  });
  await h.until(() => h.sentOp(4).length === 1, "join");
  h.voiceState(h.VC);
  await h.until(() => /^Mochi is happy ♥♥♥♡♡ · In VC for 00d-00h-00m-0\ds$/.test(custom().state || ""), "pet on the status line");
  assert.deepStrictEqual(custom().emoji, { name: "😺" }, "the pet's face is the status emoji");
  const card = h.shownActivities().find((a) => a.application_id);
  assert.strictEqual(card.details, "Chilling with Alya 🩷🎀", "the card is untouched");

  // A friend feeds it by DM.
  message(FRIEND, "feed");
  await h.until(() => h.messages.length === 1, "reply to feed");
  assert.strictEqual(lastReply().channelId, DM);
  assert(/^🍖 Yum! Mochi's food is now 95%/.test(lastReply().content), lastReply().content);

  // Things that must NOT get an answer.
  message(FRIEND, "play"); // same person again within 2 seconds
  message(STRANGER, "hey, are you there?"); // ordinary DM
  message(STRANGER, "feed", { guild_id: h.GUILD, channel_id: h.VC }); // in a server
  message("999999999999999999", "feed", { author: { id: "999999999999999999", username: "bot", discriminator: "0", bot: true } });
  await h.sleep(150);
  assert.strictEqual(h.messages.length, 1, "no automatic answer to any of those");

  // Someone whose DM opened after login (channel unknown to the library).
  message(STRANGER, "Play!", { channel_id: "777777777777777777" });
  await h.until(() => h.messages.length === 2, "reply to play");
  assert.strictEqual(lastReply().channelId, "777777777777777777");
  assert(/^🧶 That was fun! Mochi's fun is now 100%/.test(lastReply().content), lastReply().content);
  // The status line follows on its next regular refresh (every 5 seconds).
  await h.until(() => /^Mochi is very happy ♥♥♥♥♥ · /.test(custom().state || ""), "very happy on the status line", 7000);
  assert.deepStrictEqual(custom().emoji, { name: "😻" });
  assert(h.logs.some((l) => l.includes('🐾 Pet: "play" by DM')), "pet actions are logged");
  assert(!h.logs.some((l) => l.includes("are you there")), "DM text is never logged");

  // The owner's own commands.
  message(h.ME, "!pet");
  await h.until(() => h.messages.length === 3, "!pet");
  assert(/^😻 Mochi is very happy — food 9\d%, fun (100|99)%/.test(lastReply().content), lastReply().content);
  message(h.ME, "!pet name Luna");
  await h.until(() => h.messages.length === 4, "!pet name");
  assert.strictEqual(lastReply().content, "The pet is now called Luna.");

  message(h.ME, "!pet off");
  await h.until(() => h.messages.length === 5, "!pet off");
  await h.until(() => /^In VC for 00d-/.test(custom().state || ""), "pet gone from the status line", 7000);
  assert.deepStrictEqual(custom().emoji, { name: "🎧" }, "the usual emoji is back");
  message("888888888888888888", "feed");
  await h.sleep(150);
  assert.strictEqual(h.messages.length, 5, "a hidden pet does not answer DMs");

  message(h.ME, "!pet on");
  await h.until(() => /^Luna is very happy/.test(custom().state || ""), "pet back, with its new name", 7000);

  // Out of voice the pet stays on the line.
  h.voiceState(null);
  // (Checked in the log: Discord's limit of 5 status changes per 20 seconds
  // makes the library hold this one back for a few seconds.)
  await h.until(
    () => h.logs.some((l) => /custom status "😻 Luna is very happy ♥♥♥♥♥ · Total VC time: /.test(l)),
    "pet shown out of voice"
  );
});
