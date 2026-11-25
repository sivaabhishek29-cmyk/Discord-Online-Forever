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
    if (state.inVoice && clockStart) rich.timestamps = { start: clockStart };
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

  return activities;
}

module.exports = { cleanButtons, buildActivities, fetchApplication, pickAsset, fill, describeSessions, CARD_TYPES, CARD_WORDING };
