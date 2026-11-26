// Offline test (real Eris, fake socket): the purple "streaming" dot. A
// "Streaming" entry is sent with the other activities, can be switched off and
// on from chat, and a warning appears if Discord does not keep it.
const assert = require("assert");
const h = require("./harness.js");

h.start({ LIVE: "off", CARD2: "off", PRESENCE_DEBOUNCE: "20", STREAM_URL: "not a link" });
const replies = [];
require("eris").Client.prototype.createMessage = async (channelId, content) => { replies.push(content); return { id: "1" }; };
let nextId = 9000;
const say = (content) =>
  h.dispatch("MESSAGE_CREATE", {
    id: String(++nextId), channel_id: "444444444444444444", content, type: 0, timestamp: new Date().toISOString(),
    author: { id: h.ME, username: "me", discriminator: "0" },
    mentions: [], mention_roles: [], attachments: [], embeds: [],
  });
const types = () => (h.shownActivities() || []).map((a) => a.type);
const logged = (text) => h.logs.some((l) => l.includes(text));
const SESSIONS = (activities) => h.dispatch("SESSIONS_REPLACE", [
  { session_id: "gateway-session", status: "online", client_info: { client: "web", os: "linux" }, activities },
]);

h.finish("PURPLE TEST", async () => {
  assert(logged("STREAM_URL must be a Twitch or YouTube link"), "a bad link is reported at start");
  await h.until(() => h.socket() && h.sentOp(2).length === 1, "login");
  h.ready();
  await h.until(() => h.sentOp(4).length === 1, "join");
  h.voiceState(h.VC);

  // Sent last, after the status line and the card, with the fallback link.
  await h.until(() => types().join() === "4,5,1", "streaming entry sent");
  const entry = h.shownActivities()[2];
  assert.deepStrictEqual(entry, { name: "Twitch", type: 1, url: "https://www.twitch.tv/discord", details: "Live 24/7 🔴" });
  assert(logged('purple dot "Streaming Live 24/7 🔴" → https://www.twitch.tv/discord'));

  // Discord reports it back → no warning. The card count ignores it.
  SESSIONS([{ type: 4, name: "Custom Status", state: "x" }, { type: 5, name: "App", application_id: "1" }, { type: 1, name: "Twitch", url: entry.url }]);
  await h.sleep(30);
  assert(!logged("dropped the \"Streaming\" entry") && !logged("of the 1 cards"));

  // Discord reports it missing → one warning.
  SESSIONS([{ type: 4, name: "Custom Status", state: "y y" }, { type: 5, name: "App", application_id: "1" }]);
  await h.until(() => logged('Discord dropped the "Streaming" entry'), "warning when Discord drops it");
  assert(!logged("dropped the card") && !logged("of the 1 cards"), "the cards are not blamed");

  say("!purple");
  await h.until(() => replies.includes("Purple dot: on. Link: https://www.twitch.tv/discord"), "!purple reply");

  say("!purple off");
  await h.until(() => replies.some((r) => r.startsWith("Purple dot: off.")), "!purple off reply");
  await h.until(() => types().join() === "4,5", "streaming entry removed", 12000);

  say("!purple on");
  await h.until(() => types().join() === "4,5,1", "streaming entry back", 12000);

  say("!purple maybe");
  await h.until(() => replies.some((r) => r.startsWith("Usage: !purple")), "usage for an unknown word");
});
