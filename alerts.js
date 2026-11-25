// Posts short alert messages to a Discord channel webhook. The request goes
// straight from this server to the webhook link: the account's token is not
// used and the account itself sends nothing.
const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/;

function cleanWebhookUrl(value) {
  const url = String(value || "").trim().replace(/^["']|["']$/g, "").split("?")[0].replace(/\/+$/, "");
  return WEBHOOK_RE.test(url) ? url : null;
}

function formatGap(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// maxInWindow alerts per windowMs; after that one "pausing" notice, then silence
// until the window clears — a kick loop must not flood the channel.
function createAlerts({
  url,
  name = () => "Account",
  fetchImpl = (...a) => globalThis.fetch(...a),
  now = Date.now,
  log = () => {},
  maxInWindow = 8,
  windowMs = 10 * 60 * 1000,
} = {}) {
  const target = cleanWebhookUrl(url);
  let recent = [];
  let pausedNoticeSent = false;
  let chain = Promise.resolve();

  async function post(content) {
    try {
      const res = await fetchImpl(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) log(`⚠️ Alert not delivered (webhook answered HTTP ${res.status})`);
    } catch (err) {
      // Never print the webhook link: anyone holding it can post to the channel.
      const text = String(err && err.message ? err.message : err).split(target).join("[webhook]");
      log(`⚠️ Alert not delivered: ${text}`);
    }
  }

  function send(text) {
    if (!target) return false;
    const t = now();
    recent = recent.filter((x) => t - x < windowMs);
    if (!recent.length) pausedNoticeSent = false;
    let content = `**${name()}** — ${text}`;
    if (recent.length >= maxInWindow) {
      if (pausedNoticeSent) return false;
      pausedNoticeSent = true;
      content = `**${name()}** — 🔕 Too many alerts. Pausing them for ${formatGap(windowMs)}; see the Railway logs meanwhile.`;
    } else {
      recent.push(t);
    }
    chain = chain.then(() => post(content)); // keep the order they happened in
    return true;
  }

  return { enabled: !!target, send, idle: () => chain };
}

module.exports = { createAlerts, cleanWebhookUrl, formatGap };
