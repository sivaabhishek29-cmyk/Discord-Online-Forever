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
      type: 0,
      application_id: cfg.appId,
      details: clamp(state.inVoice ? fill(cfg.details, values) : fill(cfg.detailsIdle, values)),
      state: clamp(fill(cfg.state, values)),
    };
    // Discord renders a live "elapsed" clock from this, no updates needed.
    if (state.inVoice && state.stayStart) rich.timestamps = { start: state.stayStart };
    if (cfg.imageId) {
      rich.assets = { large_image: cfg.imageId, large_text: clamp(cfg.appName || "Voice Chat") };
    }
    activities.push(rich);
  }

  return activities;
}

module.exports = { buildActivities, fetchApplication, pickAsset, fill };
