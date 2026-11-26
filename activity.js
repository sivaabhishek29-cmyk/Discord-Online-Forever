// Builds what the account shows under its name: a custom status line and/or a
// Rich Presence card tied to a Discord developer application.
const API = "https://discord.com/api/v9";

const clamp = (text, max = 128) => {
  const s = String(text).trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (m, key) => (key in values ? values[key] : m));
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Looks up the application's public name and uploaded Rich Presence images.
// Both endpoints are public — the account token is never sent.
async function fetchApplication(appId, fetchImpl = globalThis.fetch) {
  const info = { name: null, assets: [], errors: [] };
  try {
    const app = await getJson(`${API}/applications/${appId}/rpc`, fetchImpl);
    if (app && app.name) info.name = app.name;
  } catch (err) {
    info.errors.push(`name: ${err.message}`);
  }
  try {
    const assets = await getJson(`${API}/oauth2/applications/${appId}/assets`, fetchImpl);
    if (Array.isArray(assets)) info.assets = assets.filter((a) => a && a.id && a.name);
  } catch (err) {
    info.errors.push(`images: ${err.message}`);
  }
  return info;
}

function pickAsset(assets, wantedName) {
  if (!assets || !assets.length) return null;
  if (wantedName) {
    const hit = assets.find((a) => a.name.toLowerCase() === String(wantedName).toLowerCase());
    if (hit) return hit;
  }
  return assets[0];
}

// Wording Discord puts in front of the card's title.
const CARD_TYPES = { playing: 0, listening: 2, watching: 3, competing: 5 };
const CARD_WORDING = { 0: "Playing", 2: "Listening to", 3: "Watching", 5: "Competing in" };

// One short line per session, from what Discord itself reports for the account.
function describeSessions(sessions, ownSessionId) {
  return (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && s.session_id !== "all")
    .map((s) => {
      const info = s.client_info || {};
      const where = s.session_id === ownSessionId ? "this app" : [info.client, info.os].filter(Boolean).join("/") || "other device";
      const acts = (s.activities || []).map((a) =>
        a.type === 4 ? `status "${a.state || ""}"` : `${CARD_WORDING[a.type] || "Activity"} ${a.name}`
      );
      return `[${where}] ${s.status}: ${acts.length ? acts.join(" + ") : "no activity"}`;
    });
}

// "31-12-2026 23:59", "31/12/2026 11:59 pm", "2026-12-31", "2026-12-31T23:59+05:30"
// → milliseconds, or null. Without a zone the time is read in `offset`
// (India time by default).
function parseWhen(text, offset = "+05:30") {
  const s = String(text || "").trim();
  const time = "(?:[T\\s,]+(\\d{1,2})[:.](\\d{2})(?::(\\d{2}))?\\s*([ap]m)?)?\\s*(z|[+-]\\d{2}:?\\d{2})?";
  let y, mo, d, rest;
  let m = new RegExp(`^(\\d{4})-(\\d{1,2})-(\\d{1,2})${time}$`, "i").exec(s);
  if (m) [, y, mo, d, ...rest] = m;
  else {
    m = new RegExp(`^(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4})${time}$`, "i").exec(s);
    if (!m) return null;
    [, d, mo, y, ...rest] = m;
  }
  const [hRaw, miRaw, secRaw, ampm, zoneRaw] = rest;
  let h = hRaw === undefined ? 0 : +hRaw;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (/p/i.test(ampm) ? 12 : 0);
  }
  const [mi, sec] = [+(miRaw || 0), +(secRaw || 0)];
  [y, mo, d] = [+y, +mo, +d];
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 59) return null;
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null; // e.g. 31 February
  let zone = (zoneRaw || offset || "+05:30").toUpperCase();
  if (zone !== "Z" && !zone.includes(":")) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const p2 = (n) => String(n).padStart(2, "0");
  const ms = Date.parse(`${y}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:${p2(sec)}${zone}`);
  return Number.isFinite(ms) ? ms : null;
}

// Up to two link buttons under the card. Discord wants the labels and the links
// in two separate lists; a button without a usable link is left out.
function cleanButtons(buttons) {
  return (Array.isArray(buttons) ? buttons : [])
    .map((b) => ({ label: clamp((b && b.label) || "", 32), url: String((b && b.url) || "").trim() }))
    .filter((b) => b.label && /^https?:\/\/\S+$/i.test(b.url) && b.url.length <= 512)
    .slice(0, 2);
}

// mode: "both" | "custom" | "rich" | "off"
function buildActivities(cfg, state) {
  const values = {
    total: state.total,
    stay: state.stay,
    channel: state.channelName || "voice",
    server: state.serverName || "",
    level: "",
  };
  const activities = [];

  if (cfg.mode === "both" || cfg.mode === "custom") {
    const text = state.inVoice ? fill(cfg.customText, values) : fill(cfg.customTextIdle, values);
    const custom = { name: "Custom Status", type: 4, state: clamp(text) };
    if (cfg.customEmoji) custom.emoji = { name: cfg.customEmoji };
    activities.push(custom);
  }

  if ((cfg.mode === "both" || cfg.mode === "rich") && cfg.appId) {
    const rich = {
      name: clamp(cfg.appName || "Voice Chat"),
      type: cfg.cardType in CARD_WORDING ? cfg.cardType : 5,
      application_id: cfg.appId,
      details: clamp(state.inVoice ? fill(cfg.details, values) : fill(cfg.detailsIdle, values)),
      state: clamp(state.inVoice ? fill(cfg.state, values) : fill(cfg.stateIdle || cfg.state, values)),
    };
    // Discord draws a clock from this that ticks every second on the viewer's
    // screen, with no updates from us. (Text can't do that: Discord only allows
    // a few status changes per 20 seconds.)
    const clockStart = cfg.clock === "stay" ? state.stayStart : state.totalStart || state.stayStart;
    // An end time makes Discord count DOWN to it instead (also ticking by itself).
    if (state.countdownEnd) rich.timestamps = { end: state.countdownEnd };
    // Started at local midnight, the same clock reads the time of day.
    else if (cfg.clock === "time" && state.dayStart) rich.timestamps = { start: state.dayStart };
    else if (state.inVoice && clockStart) rich.timestamps = { start: clockStart };
    if (cfg.imageId) {
      rich.assets = { large_image: cfg.imageId, large_text: clamp(cfg.appName || "Voice Chat") };
    }
    const buttons = cleanButtons(cfg.buttons);
    if (buttons.length) {
      rich.buttons = buttons.map((b) => b.label);
      rich.metadata = { button_urls: buttons.map((b) => b.url) };
    }
    activities.push(rich);
  }

  // Second card: a progress bar that Discord moves by itself (the way it shows
  // a song). Two kinds:
  //   "time"  — starts at local midnight, so its left-hand figure is the time of
  //             day; shown in and out of voice.
  //   "level" — fills once per level of voice time; only while in voice, since
  //             the bar cannot be paused.
  const second = cfg.card2;
  const byClock = !!second && second.bar === "time";
  const barReady = byClock ? !!state.dayStart : state.inVoice && !!state.totalStart;
  if (second && cfg.mode !== "off" && cfg.mode !== "custom" && barReady && second.levelMs > 0) {
    const total = Math.max(0, Number(state.totalMs) || 0);
    const done = Math.floor(total / second.levelMs); // levels of voice time completed
    const start = byClock ? state.dayStart : state.totalStart + done * second.levelMs;
    const levelValues = { ...values, level: String(done + 1) };
    const bar = {
      name: clamp(fill(second.name || "{channel}", levelValues)) || "voice",
      type: second.type === 3 ? 3 : 2, // only "Watching" and "Listening to" draw a bar
    };
    if (second.appId) bar.application_id = second.appId;
    // A line that is left empty is simply not shown.
    const line1 = clamp(fill(second.details || "", levelValues));
    const line2 = clamp(fill(second.state || "", levelValues));
    if (line1) bar.details = line1;
    if (line2) bar.state = line2;
    bar.timestamps = { start, end: start + second.levelMs };
    if (second.appId && second.imageId) bar.assets = { large_image: second.imageId, large_text: bar.name };
    activities.push(bar);
  }

  return activities;
}

module.exports = { parseWhen, cleanButtons, buildActivities, fetchApplication, pickAsset, fill, describeSessions, CARD_TYPES, CARD_WORDING };
