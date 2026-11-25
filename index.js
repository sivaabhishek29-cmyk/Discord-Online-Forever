const Eris = require("eris");
const keepAlive = require("./keep_alive.js");
const path = require("path");
const { applyUserAccountPatch, forceShardReady } = require("./eris_user_patch.js");
const { createVcTimer, formatDuration, formatStopwatch } = require("./vc_timer.js");
const { createAlerts, formatGap } = require("./alerts.js");
const {
  buildActivities,
  parseWhen,
  fetchApplication,
  pickAsset,
  describeSessions,
  CARD_TYPES,
  CARD_WORDING,
} = require("./activity.js");

// ---------------------------------------------------------------------------
// Config (env vars)
// ---------------------------------------------------------------------------
// Token: supports the original `token` name plus common aliases.
// Trim whitespace/quotes — Railway UI sometimes pastes them in.
const TOKEN = (
  process.env.token || process.env.TOKEN || process.env.DISCORD_TOKEN || ""
)
  .trim()
  .replace(/^["']|["']$/g, "");

// Voice channel to stay in. Supports several aliases so Replit / Render /
// Railway / local .env all work. Example: VOICE_CHANNEL_ID=123456789012345678
let targetChannelId =
  process.env.VOICE_CHANNEL_ID ||
  process.env.VC_ID ||
  process.env.CHANNEL_ID ||
  process.env.voiceChannelId ||
  "";

// Optional: only used for logging/validation. Not required to join.
const targetGuildId = process.env.GUILD_ID || process.env.SERVER_ID || "";

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function parseIntEnv(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// How the account shows in VC: mic on (not muted), deafened.
// No audio is ever sent or received either way — no voice connection is opened.
const SELF_MUTE = parseBool(process.env.SELF_MUTE, false);
const SELF_DEAF = parseBool(
  process.env.SELF_DEAF ?? process.env.SELF_DEAFEN,
  true
);

// Auto-rejoin when kicked / moved / disconnected.
const AUTO_REJOIN = parseBool(process.env.AUTO_REJOIN, true);
const REJOIN_DELAY = parseIntEnv(process.env.REJOIN_DELAY, 5000);
const WATCHDOG_INTERVAL = parseIntEnv(process.env.WATCHDOG_INTERVAL, 30000);
const COMMAND_PREFIX = process.env.COMMAND_PREFIX || "!";

const JOIN_CONFIRM_TIMEOUT = parseIntEnv(process.env.JOIN_CONFIRM_TIMEOUT, 10000);
const READY_TIMEOUT = parseIntEnv(process.env.READY_TIMEOUT, 45000);
const RECONNECT_AFTER = parseIntEnv(process.env.RECONNECT_AFTER, 180000);
const REASSERT_INTERVAL = parseIntEnv(process.env.REASSERT_INTERVAL, 300000);
const DEBUG = parseBool(process.env.DEBUG, false);

// --- Activity (what shows under the account's name) -------------------------
const ACTIVITY_MODES = ["both", "custom", "rich", "off"];
const ACTIVITY_MODE = ACTIVITY_MODES.includes((process.env.ACTIVITY || "").trim().toLowerCase())
  ? process.env.ACTIVITY.trim().toLowerCase()
  : "both";
const STATUSES = ["online", "idle", "dnd", "invisible"];
const STATUS = STATUSES.includes((process.env.STATUS || "").trim().toLowerCase())
  ? process.env.STATUS.trim().toLowerCase()
  : "online";
// Discord developer application used for the Rich Presence card (public ID, not a secret).
const APPLICATION_ID = (process.env.APPLICATION_ID || "1575262829869662312").trim();
const DEFAULT_CUSTOM_TEXT = "In VC for {total}";
const ACTIVITY_TYPE = (process.env.ACTIVITY_TYPE || "competing").trim().toLowerCase();
function buttonFromEnv(n, defaultLabel, defaultUrl) {
  const label = process.env[`BUTTON${n}_LABEL`] === undefined ? defaultLabel : process.env[`BUTTON${n}_LABEL`].trim();
  const url = (process.env[`BUTTON${n}_URL`] || defaultUrl).trim();
  return /^(off|none|false|0)?$/i.test(label) ? null : { label, url };
}

const activityConfig = {
  mode: ACTIVITY_MODE,
  cardType: ACTIVITY_TYPE in CARD_TYPES ? CARD_TYPES[ACTIVITY_TYPE] : CARD_TYPES.competing,
  // What the card's ticking clock counts: lifetime VC time, or only the current stay.
  clock: (process.env.ACTIVITY_CLOCK || "").trim().toLowerCase() === "stay" ? "stay" : "total",
  appId: /^\d{15,25}$/.test(APPLICATION_ID) ? APPLICATION_ID : null,
  appName: process.env.ACTIVITY_NAME || null, // filled in from Discord if not set
  imageId: null, // filled in from the application's uploaded images
  customText: process.env.CUSTOM_STATUS || DEFAULT_CUSTOM_TEXT,
  customTextIdle: "Total VC time: {total}",
  customEmoji: process.env.CUSTOM_STATUS_EMOJI === undefined ? "🎧" : process.env.CUSTOM_STATUS_EMOJI,
  details: process.env.ACTIVITY_DETAILS || "Chilling with Alya 🩷🎀",
  detailsIdle: "Not in voice right now",
  state: process.env.ACTIVITY_STATE || "dev Lovelycrxshx ♠",
  stateIdle: "Total VC time: {total}",
  // Link buttons under the card. Set a label to "off" to remove that button.
  buttons: [
    // Discord allows at most 32 characters on a button.
    buttonFromEnv(1, "Self-run acc, not a real user", "https://discord.com/users/825998094067695616"),
    buttonFromEnv(2, "Contact Admin", "https://discord.com/users/825998094067695616"),
  ],
};
const ACTIVITY_IMAGE = process.env.ACTIVITY_IMAGE || "";
// How often the shown time is sent to Discord: once a minute. Faster makes the
// account look automated; 5s is the floor (Discord allows 5 status changes per
// 20 seconds and disconnects accounts that go over).
const ACTIVITY_REFRESH = Math.max(5000, parseIntEnv(process.env.ACTIVITY_REFRESH, 60000));
// Seconds in the text only make sense when the text is refreshed often.
const TEXT_SECONDS = ACTIVITY_REFRESH < 30000;
// Card clock counts down to this moment instead of counting up (see !countdown).
const COUNTDOWN_OFFSET = /^[+-]\d{2}:\d{2}$/.test((process.env.COUNTDOWN_OFFSET || "").trim())
  ? process.env.COUNTDOWN_OFFSET.trim()
  : "+05:30"; // India time
// Alerts to a Discord channel webhook (posted by this server, not by the account).
const ALERT_OFFLINE_AFTER = parseIntEnv(process.env.ALERT_OFFLINE_AFTER, 60000);
const ALERT_VC_AFTER = parseIntEnv(process.env.ALERT_VC_AFTER, 120000);
const PRESENCE_DEBOUNCE = parseIntEnv(process.env.PRESENCE_DEBOUNCE, 2000);

// --- VC timer storage -------------------------------------------------------
// Railway sets RAILWAY_VOLUME_MOUNT_PATH when a Volume is attached to the service.
const DATA_DIR =
  process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
const HAS_PERSISTENT_DISK = !!(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH);
const ON_RAILWAY = !!(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT);

// Eris channel types: 2 = GUILD_VOICE, 13 = GUILD_STAGE_VOICE
const VOICE_TYPES = new Set([2, 13]);
const GATEWAY_OP_VOICE_STATE_UPDATE = 4;
const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let bot = null;
// Our own voice state as reported by Discord (VOICE_STATE_UPDATE packets):
// { guildId, channelId, sessionId, selfMute, selfDeaf } or null when not in VC.
let selfVoice = null;
let ourVoiceSessionId = null; // session that *this process* joined voice with
let pendingJoin = null; // { channelId, resolve } while waiting for Discord to confirm
let joining = false; // guard against concurrent join attempts
let intentionalLeave = false; // true after `!leave` until next `!join`
let rejoinTimer = null;
let watchdogTimer = null;
let everReady = false;
let lastMuteFix = 0;
let unconfirmedJoins = 0; // join attempts in a row that Discord did not answer
let gatewaySessionId = null; // changes only when Discord gives us a brand-new session
let knownSessionIds = null; // the account's live sessions, as last reported by Discord
let lastReassert = 0;
let vcTimer = null; // created in main()
let alerts = null; // created in main()
let startAlertSent = false;
let tokenAlertSent = false;
let offlineSince = 0;
let offlineAlerted = false;
let voiceLostAt = 0; // when we were put out of the target VC (0 = not out)
let outOfVoiceSince = 0;
let voiceStuckAlerted = false;
let lastPresence = null; // JSON of the last activity list sent
let lastPresenceShape = null;
let appLookupDone = false;
let appLookupAt = 0;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function safeErr(err) {
  const msg = err && err.message ? err.message : String(err);
  // Eris includes the token in "Invalid token" errors — never log it.
  return TOKEN ? msg.split(TOKEN).join("[redacted]") : msg;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getSelfVoiceChannelId() {
  return selfVoice ? selfVoice.channelId : null;
}

// True when the account is in voice from another device/session (phone, PC).
function heldByOtherDevice() {
  return !!(
    selfVoice &&
    selfVoice.sessionId &&
    ourVoiceSessionId &&
    selfVoice.sessionId !== ourVoiceSessionId
  );
}

function describeChannel(channelId) {
  if (!channelId) return "none";
  const channel = bot ? bot.getChannel(channelId) : null;
  if (!channel) return channelId;
  const guildName = channel.guild ? channel.guild.name : "DM";
  return `#${channel.name} (${channel.id}) in ${guildName}`;
}

function listVoiceChannels() {
  const lines = [];
  for (const guild of bot.guilds.values()) {
    for (const channel of guild.channels.values()) {
      if (VOICE_TYPES.has(channel.type)) {
        lines.push(`  - #${channel.name} (${channel.id}) in ${guild.name} (${guild.id})`);
      }
    }
  }
  return lines;
}

function guildIdForChannel(channelId) {
  if (!bot) return null;
  const channel = bot.getChannel(channelId);
  if (channel && channel.guild) return channel.guild.id;
  return (bot.channelGuildMap && bot.channelGuildMap[channelId]) || targetGuildId || null;
}

// Joining/leaving a VC is a plain gateway message (opcode 4). We deliberately
// do NOT open Eris' voice websocket/UDP connection: sitting in a channel does
// not need one, and Eris 0.17's voice stack uses an encryption mode Discord no
// longer offers, so it would just time out and drop us back out of the VC.
function sendVoiceState(guildId, channelId, flipDeaf = false) {
  const shardId = (bot.guildShardMap && bot.guildShardMap[guildId]) || 0;
  const shard = bot.shards.get(shardId);
  if (!shard) return false;
  shard.sendWS(GATEWAY_OP_VOICE_STATE_UPDATE, {
    guild_id: guildId,
    channel_id: channelId || null,
    self_mute: SELF_MUTE,
    self_deaf: flipDeaf ? !SELF_DEAF : SELF_DEAF,
  });
  return true;
}

function ensureMuteDeaf() {
  if (!selfVoice || heldByOtherDevice()) return;
  if (selfVoice.channelId !== targetChannelId) return;
  if (selfVoice.selfMute === SELF_MUTE && selfVoice.selfDeaf === SELF_DEAF) return;
  if (Date.now() - lastMuteFix < 5000) return; // don't spam the gateway
  lastMuteFix = Date.now();
  log(`🎙️ Re-applying mute=${SELF_MUTE} deaf=${SELF_DEAF}`);
  sendVoiceState(selfVoice.guildId, selfVoice.channelId);
}

function scheduleRejoin(reason) {
  if (!AUTO_REJOIN) return;
  if (intentionalLeave) return;
  if (!targetChannelId) return;
  if (rejoinTimer) return; // already scheduled
  // Back off while Discord keeps not answering, up to once a minute.
  const delay = Math.min(REJOIN_DELAY * 2 ** Math.min(unconfirmedJoins, 4), Math.max(REJOIN_DELAY, 60000));
  log(`🔁 Will rejoin ${describeChannel(targetChannelId)} in ${delay}ms (${reason})`);
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null;
    if (intentionalLeave || heldByOtherDevice()) return;
    joinVoice();
  }, delay);
  // Don't keep the process alive just for this timer.
  if (rejoinTimer.unref) rejoinTimer.unref();
}

// Every VOICE_STATE_UPDATE about our own account lands here.
function onSelfVoiceState(d) {
  const previous = selfVoice;

  if (!d.channel_id) {
    // Only a "left" if it is about the voice state we are tracking. Other
    // devices of the account announce "not in voice here" (no server, their own
    // session) when they log in — that does not take us out of the channel.
    if (previous && d.guild_id && previous.guildId !== d.guild_id) return;
    if (previous && !d.guild_id && d.session_id && previous.sessionId && d.session_id !== previous.sessionId) {
      return;
    }
    selfVoice = null;
    updateStatus();
    if (previous) {
      log(`⚠️ No longer in ${describeChannel(previous.channelId)} (kicked, disconnected or left)`);
      if (!intentionalLeave) {
        if (!voiceLostAt) voiceLostAt = Date.now();
        sendAlert(`⚠️ Removed from ${channelLabel(previous.channelId)} (kicked or disconnected). Rejoining…`);
      }
    }
    scheduleRejoin("left voice channel");
    return;
  }

  selfVoice = {
    guildId: d.guild_id || guildIdForChannel(d.channel_id),
    channelId: d.channel_id,
    sessionId: d.session_id || null,
    selfMute: !!d.self_mute,
    selfDeaf: !!d.self_deaf,
  };
  updateStatus();

  // Confirmation of a join we just asked for.
  if (pendingJoin && pendingJoin.channelId === d.channel_id) {
    ourVoiceSessionId = d.session_id || ourVoiceSessionId;
    pendingJoin.resolve(true);
    return;
  }

  if (heldByOtherDevice()) {
    if (!previous || previous.sessionId !== selfVoice.sessionId) {
      log(
        `📱 Voice taken over by another device (now in ${describeChannel(d.channel_id)}). ` +
          "Not fighting it — will rejoin the target VC when that device leaves voice."
      );
      sendAlert(`📱 Voice was taken over by another device (now in ${channelLabel(d.channel_id)}). Waiting for it to leave voice.`);
    }
    return;
  }

  if (targetChannelId && d.channel_id !== targetChannelId) {
    if (!previous || previous.channelId !== d.channel_id) {
      log(`⚠️ Moved to ${describeChannel(d.channel_id)} — going back to target`);
      if (!voiceLostAt) voiceLostAt = Date.now();
      sendAlert(`⚠️ Moved to ${channelLabel(d.channel_id)}. Going back to ${channelLabel(targetChannelId)}…`);
    }
    scheduleRejoin("moved to another channel");
    return;
  }

  ensureMuteDeaf();
}

async function joinVoice(channelId = targetChannelId) {
  if (!channelId) {
    log("ℹ️ No VOICE_CHANNEL_ID set — staying online only. Send `!join <channelId>` in DM to join a VC.");
    return false;
  }
  if (!bot || !bot.ready) {
    log("ℹ️ Not ready yet — will join once connected.");
    return false;
  }
  if (joining) return false;

  // Already sitting in the target channel.
  if (getSelfVoiceChannelId() === channelId && !heldByOtherDevice()) {
    ensureMuteDeaf();
    return true;
  }

  const channel = bot.getChannel(channelId);
  if (channel && !VOICE_TYPES.has(channel.type)) {
    log(`❌ Channel ${describeChannel(channelId)} is not a voice channel (type=${channel.type}).`);
    return false;
  }
  const guildId = guildIdForChannel(channelId);
  if (!guildId) {
    log(
      `❌ Voice channel ${channelId} not found. Is the account in that server, and is the ID a ` +
        `*channel* ID (not a server ID)? Set GUILD_ID to the server ID to force it. ` +
        `Available VCs:\n${listVoiceChannels().join("\n") || "  (none)"}`
    );
    scheduleRejoin("channel not found");
    return false;
  }
  if (targetGuildId && guildId !== targetGuildId) {
    log(`⚠️ Channel is in guild ${guildId}, expected GUILD_ID=${targetGuildId}. Joining anyway.`);
  }

  joining = true;
  try {
    log(`🎧 Joining ${describeChannel(channelId)} (mute=${SELF_MUTE} deaf=${SELF_DEAF})...`);
    const confirmed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), JOIN_CONFIRM_TIMEOUT);
      if (timer.unref) timer.unref();
      pendingJoin = {
        channelId,
        resolve: (ok) => {
          clearTimeout(timer);
          pendingJoin = null;
          resolve(ok);
        },
      };
      // Discord stays silent when it thinks nothing changed (e.g. the account is
      // already in the channel but we lost track). After a silent attempt, flip
      // the deafen flag on every other try so there is a change to report back.
      const flip = unconfirmedJoins % 2 === 1;
      if (!sendVoiceState(guildId, channelId, flip)) resolve(false);
    });
    pendingJoin = null;

    if (confirmed) {
      unconfirmedJoins = 0;
      lastReassert = Date.now();
      log(`✅ Joined ${describeChannel(channelId)} — staying here`);
      if (voiceLostAt) sendAlert(`✅ Back in ${channelLabel(channelId)} after ${formatGap(Date.now() - voiceLostAt)}.`);
      voiceLostAt = 0;
      lastMuteFix = 0;
      ensureMuteDeaf(); // puts the flags right if this attempt flipped one
      return true;
    }
    unconfirmedJoins++;
    log(
      `❌ Discord did not confirm joining ${describeChannel(channelId)} within ${JOIN_CONFIRM_TIMEOUT}ms ` +
        `(attempt ${unconfirmedJoins}). Usual causes: no Connect permission, channel is full, or wrong channel ID.`
    );
    scheduleRejoin("join not confirmed");
    return false;
  } catch (err) {
    pendingJoin = null;
    log(`❌ Failed to join ${describeChannel(channelId)}: ${safeErr(err)}`);
    scheduleRejoin(`join failed: ${safeErr(err)}`);
    return false;
  } finally {
    joining = false;
  }
}

function leaveVoice() {
  intentionalLeave = true;
  if (rejoinTimer) {
    clearTimeout(rejoinTimer);
    rejoinTimer = null;
  }
  const guildId = selfVoice ? selfVoice.guildId : guildIdForChannel(targetChannelId);
  try {
    if (bot && guildId) sendVoiceState(guildId, null);
  } catch (err) {
    log(`⚠️ Leave error: ${safeErr(err)}`);
  }
  log("👋 Left voice channel (auto-rejoin paused until `!join`)");
}

function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (!bot || !bot.ready || !targetChannelId) return;
    if (intentionalLeave || !AUTO_REJOIN) return;

    if (heldByOtherDevice()) {
      // Another device has the voice session. If Discord says that device is
      // gone, nobody told us it left — take the channel back.
      if (knownSessionIds && !knownSessionIds.has(selfVoice.sessionId)) {
        log("📱 The other device that held voice is gone — rejoining");
        selfVoice = null;
        safely("activity", syncTimerAndPresence);
        joinVoice();
      }
      return;
    }

    const currentId = getSelfVoiceChannelId();
    if (currentId !== targetChannelId) {
      log(
        `🐕 Watchdog: currently in ${currentId ? describeChannel(currentId) : "no VC"}, ` +
          `expected ${describeChannel(targetChannelId)} — rejoining`
      );
      joinVoice();
      return;
    }

    ensureMuteDeaf();
    // We only know we are in the channel from what Discord told us earlier. Say
    // "I'm in this channel" again every few minutes: it changes nothing if that
    // is still true, and puts the account back if it was dropped without notice.
    if (!joining && Date.now() - lastReassert >= REASSERT_INTERVAL) {
      lastReassert = Date.now();
      if (DEBUG) log("🐕 Watchdog: re-asserting the voice channel");
      sendVoiceState(selfVoice.guildId, targetChannelId);
    }
  }, WATCHDOG_INTERVAL);
  if (watchdogTimer.unref) watchdogTimer.unref();
  log(`🐕 Watchdog started (every ${WATCHDOG_INTERVAL}ms)`);
}

// ---------------------------------------------------------------------------
// VC timer + activity
// ---------------------------------------------------------------------------
// --- Alerts -----------------------------------------------------------------
function channelLabel(channelId) {
  const channel = bot && channelId ? bot.getChannel(channelId) : null;
  return channel && channel.name ? `#${channel.name}` : `channel ${channelId}`;
}

function sendAlert(text) {
  if (!alerts || !alerts.enabled) return;
  safely("alert", () => alerts.send(text));
}

// Slow things (offline, stuck outside the channel) are noticed here; kicks and
// moves raise their alert the moment Discord reports them.
function alertTick() {
  if (!alerts || !alerts.enabled || !bot) return;
  const t = Date.now();
  if (!bot.ready) {
    if (!offlineSince) offlineSince = t;
    if (fatalReason) {
      if (!tokenAlertSent) {
        tokenAlertSent = true;
        sendAlert("❌ Discord rejected the token. Put a fresh token in the Railway `token` variable.");
      }
    } else if (!offlineAlerted && t - offlineSince >= ALERT_OFFLINE_AFTER) {
      offlineAlerted = true;
      sendAlert(
        startAlertSent
          ? `🔴 Offline for ${formatGap(t - offlineSince)}. Reconnecting…`
          : `🔴 Still not logged in ${formatGap(t - offlineSince)} after starting. Still trying.`
      );
    }
    return;
  }

  if (!startAlertSent) {
    startAlertSent = true;
    sendAlert("🟢 Online (the app has just started).");
  } else if (offlineAlerted || tokenAlertSent) {
    sendAlert(`🟢 Back online after ${formatGap(t - offlineSince)}.`);
  }
  offlineSince = 0;
  offlineAlerted = false;
  tokenAlertSent = false;

  const wanted = targetChannelId && AUTO_REJOIN && !intentionalLeave && !heldByOtherDevice();
  if (wanted && getSelfVoiceChannelId() !== targetChannelId) {
    if (!outOfVoiceSince) outOfVoiceSince = t;
    if (!voiceStuckAlerted && t - outOfVoiceSince >= ALERT_VC_AFTER) {
      voiceStuckAlerted = true;
      if (!voiceLostAt) voiceLostAt = outOfVoiceSince; // so "Back in" follows later
      sendAlert(`⚠️ Not in ${channelLabel(targetChannelId)} for ${formatGap(t - outOfVoiceSince)}. Still trying to join.`);
    }
  } else {
    outOfVoiceSince = 0;
    voiceStuckAlerted = false;
  }
}

// --- Countdown --------------------------------------------------------------
// Returns the moment the card's clock counts down to, or null (count up).
function countdownEnd() {
  const saved = vcTimer.get("countdownTo"); // number = set from chat, 0 = switched off from chat
  const end = Number.isFinite(saved) ? saved : parseWhen(process.env.COUNTDOWN_TO, COUNTDOWN_OFFSET);
  return end && end > Date.now() ? end : null;
}

function whenText(ms) {
  const sign = COUNTDOWN_OFFSET[0] === "-" ? -1 : 1;
  const shift = sign * (+COUNTDOWN_OFFSET.slice(1, 3) * 60 + +COUNTDOWN_OFFSET.slice(4, 6)) * 60000;
  const iso = new Date(ms + shift).toISOString();
  const [y, mo, d] = iso.slice(0, 10).split("-");
  return `${d}-${mo}-${y} ${iso.slice(11, 16)} (UTC${COUNTDOWN_OFFSET})`;
}

function inVoiceNow() {
  return !!(bot && bot.ready && selfVoice);
}

function timerText() {
  const total = formatDuration(vcTimer.totalMs());
  return inVoiceNow()
    ? `In VC for ${formatDuration(vcTimer.stayMs())} this stay — ${total} in total`
    : `Not in VC right now — ${total} in total`;
}

function activityEnabled() {
  return activityConfig.mode !== "off" && !vcTimer.get("activityOff");
}

let presenceDebounce = null;
let cardSent = false; // true when the last update included the card
let lastSessionsLine = null;
let privacyWarned = false;

// Discord tells every device of the account what each session is showing.
// Logging that is the only real proof of what other people can see.
function onSessions(sessions) {
  const ownId = bot && bot.shards.get(0) ? bot.shards.get(0).sessionID : null;
  const lines = describeSessions(sessions, ownId);
  if (!lines.length) return;
  const line = lines.join(" | ");
  // The shown time changes constantly; only log when the make-up changes.
  const key = line.replace(/\d+/g, "#");
  if (key === lastSessionsLine && !DEBUG) return;
  lastSessionsLine = key;
  log(`👁️ Discord reports this account as → ${line}`);

  const own = sessions.find((s) => s && s.session_id === ownId);
  if (own && cardSent && !(own.activities || []).some((a) => a.application_id)) {
    log(
      "⚠️ Discord kept the status line but dropped the card. Check that APPLICATION_ID is the " +
        "Application ID from the Developer Portal (General Information page), copied in full."
    );
  }
}

// The card is hidden from everyone when the account has activity sharing off.
function checkActivityPrivacy() {
  const settings = bot && bot.userSettings;
  if (privacyWarned || !settings || settings.show_current_game !== false) return;
  privacyWarned = true;
  log(
    "⚠️ This account has activity sharing switched OFF, so the card is hidden from other people " +
      "(the custom status still shows). On the Testiddc account open Settings > Activity Privacy and " +
      "turn on \"Share your detected activities with others\"."
  );
}

// Counts time only while the account is really in a voice channel, then
// refreshes what is shown under its name.
function syncTimerAndPresence() {
  if (!vcTimer) return;
  if (inVoiceNow()) vcTimer.start();
  else vcTimer.stop();
  // Wait a moment so a kick + instant rejoin sends one update, not three.
  if (presenceDebounce) return;
  presenceDebounce = setTimeout(() => {
    presenceDebounce = null;
    refreshPresence();
  }, PRESENCE_DEBOUNCE);
  if (presenceDebounce.unref) presenceDebounce.unref();
}

function refreshPresence() {
  if (!bot || !bot.ready || !vcTimer) return;
  try {
    const inVoice = inVoiceNow();
    const channel = inVoice ? bot.getChannel(selfVoice.channelId) : null;
    const cfg = { ...activityConfig, customText: vcTimer.get("customText") || activityConfig.customText };
    const activities = activityEnabled()
      ? buildActivities(cfg, {
          inVoice,
          channelName: channel ? channel.name : null,
          serverName: channel && channel.guild ? channel.guild.name : null,
          total: formatStopwatch(vcTimer.totalMs(), TEXT_SECONDS),
          stay: formatStopwatch(vcTimer.stayMs(), TEXT_SECONDS),
          countdownEnd: countdownEnd(),
          stayStart: vcTimer.stayStart(),
          totalStart: vcTimer.totalStart(),
        })
      : [];
    const payload = JSON.stringify([STATUS, activities]);
    if (payload === lastPresence) return;
    lastPresence = payload;
    bot.editStatus(STATUS, activities);

    // Log when the kind of activity changes, not on every time tick.
    cardSent = activities.some((a) => a.application_id);
    const shape = `${activities.map((a) => a.type).join(",")}|${inVoice}|${cfg.customText}|${cfg.appName}|${cfg.imageId}|${countdownEnd() || ""}`;
    if (shape !== lastPresenceShape || DEBUG) {
      lastPresenceShape = shape;
      if (!activities.length) {
        log(`🎭 Activity cleared (status: ${STATUS})`);
      } else {
        const parts = activities.map((a) =>
          a.type === 4
            ? `custom status "${a.emoji ? `${a.emoji.name} ` : ""}${a.state}"`
            : `card "${CARD_WORDING[a.type]} ${a.name}" — ${a.details} / ${a.state}${a.assets ? " (with image)" : " (no image)"}` +
              (a.timestamps && a.timestamps.end ? `, counting down to ${whenText(a.timestamps.end)}` : "")
        );
        log(`🎭 Activity set (status: ${STATUS}): ${parts.join(" + ")}`);
      }
    }
  } catch (err) {
    log(`⚠️ Could not update activity: ${safeErr(err)}`);
  }
}

// Fetches the application's name and image once (retries every 10 min on failure).
async function lookupApplication() {
  const wantsCard = activityConfig.mode === "both" || activityConfig.mode === "rich";
  if (!wantsCard || !activityConfig.appId || appLookupDone) return;
  if (Date.now() - appLookupAt < 600000) return;
  appLookupAt = Date.now();
  try {
    const info = await fetchApplication(activityConfig.appId);
    if (info.name && !process.env.ACTIVITY_NAME) activityConfig.appName = info.name;
    const asset = pickAsset(info.assets, ACTIVITY_IMAGE);
    if (asset) activityConfig.imageId = asset.id;

    if (info.errors.length) {
      log(`⚠️ Could not read application ${activityConfig.appId} from Discord (${info.errors.join("; ")}) — will retry later`);
    } else {
      appLookupDone = true;
      log(
        `🖼️ Application "${info.name || "?"}": ` +
          (asset
            ? `using image "${asset.name}"` +
              (info.assets.length > 1 ? ` (others: ${info.assets.filter((a) => a !== asset).map((a) => a.name).join(", ")})` : "")
            : "no images uploaded — the card will show without a picture. " +
              "Add one in the Developer Portal > your app > Rich Presence > Art Assets.")
      );
    }
    refreshPresence();
  } catch (err) {
    log(`⚠️ Application lookup failed: ${safeErr(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Self-commands (only the account owner can use these)
// ---------------------------------------------------------------------------
function extractChannelId(text) {
  if (!text) return null;
  const mention = text.match(/<#(\d{15,25})>/);
  if (mention) return mention[1];
  const raw = text.match(/\b(\d{15,25})\b/);
  return raw ? raw[1] : null;
}

async function reply(msg, text) {
  try {
    await bot.createMessage(msg.channel.id, text);
  } catch (err) {
    log(`⚠️ Failed to reply: ${safeErr(err)}`);
  }
}

async function handleCommand(msg) {
  const content = (msg.content || "").trim();
  if (!content.startsWith(COMMAND_PREFIX)) return;
  const [cmdRaw, ...rest] = content.slice(COMMAND_PREFIX.length).split(/\s+/);
  const cmd = (cmdRaw || "").toLowerCase();
  const arg = rest.join(" ").trim();

  if (cmd === "help") {
    await reply(
      msg,
      [
        "Commands (self only):",
        `${COMMAND_PREFIX}join <channelId> — join a VC and stay there`,
        `${COMMAND_PREFIX}leave — leave VC and pause auto-rejoin`,
        `${COMMAND_PREFIX}status — show current VC / target / connection`,
        `${COMMAND_PREFIX}vcs — list all voice channels`,
        `${COMMAND_PREFIX}timer — time spent in VC (this stay + total)`,
        `${COMMAND_PREFIX}activity <text> — change the custom status ({total}, {stay}, {channel} are filled in)`,
        `${COMMAND_PREFIX}activity off | on | reset — hide / show the activity, or restore the default text`,
        `${COMMAND_PREFIX}countdown 31-12-2026 23:59 — the card's clock counts down to that moment; ${COMMAND_PREFIX}countdown off — count up again`,
        `${COMMAND_PREFIX}help — this message`,
      ].join("\n")
    );
    return;
  }

  if (cmd === "vcs" || cmd === "vc" || cmd === "channels") {
    const lines = listVoiceChannels();
    await reply(msg, lines.length ? `Voice channels:\n${lines.join("\n")}` : "No voice channels found.");
    return;
  }

  if (cmd === "countdown") {
    const word = arg.toLowerCase();
    if (!arg) {
      const end = countdownEnd();
      await reply(
        msg,
        end
          ? `Counting down to ${whenText(end)} — ${formatGap(end - Date.now())} left.`
          : `No countdown running. Set one with: ${COMMAND_PREFIX}countdown 31-12-2026 23:59`
      );
    } else if (word === "off" || word === "stop") {
      vcTimer.set("countdownTo", 0);
      refreshPresence();
      await reply(msg, "Countdown off. The card's clock counts up again.");
    } else if (word === "reset") {
      vcTimer.set("countdownTo", null);
      refreshPresence();
      await reply(msg, "Countdown reset to the COUNTDOWN_TO variable.");
    } else {
      const end = parseWhen(arg, COUNTDOWN_OFFSET);
      if (!end) {
        await reply(msg, `I could not read that date. Write it like: ${COMMAND_PREFIX}countdown 31-12-2026 23:59`);
      } else if (end <= Date.now()) {
        await reply(msg, `${whenText(end)} is already in the past.`);
      } else {
        vcTimer.set("countdownTo", end);
        refreshPresence();
        await reply(msg, `Counting down to ${whenText(end)} — ${formatGap(end - Date.now())} left.`);
      }
    }
    return;
  }

  if (cmd === "timer" || cmd === "time") {
    await reply(msg, timerText());
    return;
  }

  if (cmd === "activity") {
    const word = arg.toLowerCase();
    if (!arg) {
      const text = vcTimer.get("customText") || activityConfig.customText;
      await reply(
        msg,
        `Activity: ${activityEnabled() ? activityConfig.mode : "off"}\nCustom status text: ${text}\n` +
          `Card: ${activityConfig.appName || "(app name not loaded yet)"}${activityConfig.imageId ? " with image" : ", no image"}`
      );
    } else if (word === "off" || word === "on") {
      if (activityConfig.mode === "off") {
        await reply(msg, "Activity is switched off by the ACTIVITY variable.");
        return;
      }
      vcTimer.set("activityOff", word === "off" ? true : null);
      refreshPresence();
      await reply(msg, `Activity ${word}.`);
    } else if (word === "reset") {
      vcTimer.set("customText", null);
      refreshPresence();
      await reply(msg, `Custom status text reset to: ${activityConfig.customText}`);
    } else {
      vcTimer.set("customText", arg.slice(0, 120));
      refreshPresence();
      await reply(msg, `Custom status text set to: ${arg.slice(0, 120)}`);
    }
    return;
  }

  if (cmd === "status") {
    const currentId = getSelfVoiceChannelId();
    await reply(
      msg,
      [
        `User: ${bot.user.username} (${bot.user.id})`,
        `Current VC: ${currentId ? describeChannel(currentId) : "none"}`,
        `Target VC: ${targetChannelId ? describeChannel(targetChannelId) : "not set (use !join <id>)"}`,
        `Held by another device: ${heldByOtherDevice()}`,
        `Auto-rejoin: ${AUTO_REJOIN} (paused=${intentionalLeave})`,
        `Mute/deaf: ${SELF_MUTE}/${SELF_DEAF}`,
        `Timer: ${timerText()}`,
      ].join("\n")
    );
    return;
  }

  if (cmd === "leave") {
    leaveVoice();
    await reply(msg, "Left voice channel. Auto-rejoin paused — send `!join <channelId>` to rejoin.");
    return;
  }

  if (cmd === "join") {
    const id = extractChannelId(arg);
    if (!id) {
      if (targetChannelId) {
        intentionalLeave = false;
        await joinVoice(targetChannelId);
        await reply(msg, `Joining ${describeChannel(targetChannelId)}...`);
      } else {
        const lines = listVoiceChannels();
        await reply(
          msg,
          `Usage: ${COMMAND_PREFIX}join <channelId>\nVoice channels:\n${lines.join("\n") || "  (none)"}`
        );
      }
      return;
    }
    targetChannelId = id;
    intentionalLeave = false;
    if (rejoinTimer) {
      clearTimeout(rejoinTimer);
      rejoinTimer = null;
    }
    await joinVoice(id);
    await reply(msg, `Joining ${describeChannel(id)}...`);
    return;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
let fatalReason = null; // set when Discord rejects the login for good

function updateStatus() {
  try {
    keepAlive.setStatus({
      ready: !!(bot && bot.ready),
      user: bot && bot.user ? bot.user.id : null,
      vc: getSelfVoiceChannelId(),
      target: targetChannelId || null,
      inTarget: !!targetChannelId && getSelfVoiceChannelId() === targetChannelId,
      error: fatalReason,
    });
    if (vcTimer && keepAlive.setLive) {
      keepAlive.setLive(() => ({
        vcTotal: formatDuration(vcTimer.totalMs()),
        vcTotalSeconds: Math.floor(vcTimer.totalMs() / 1000),
        vcThisStay: formatDuration(vcTimer.stayMs()),
        timerSurvivesRedeploy: HAS_PERSISTENT_DISK,
      }));
    }
  } catch {
    // ignore
  }
}

const UNKNOWN_CHANNEL = /^Unknown (guild )?(text )?channel type/;
let skippedChannels = 0;
const DEBUG_IMPORTANT = /reconnect|disconnected|heartbeat timeout|invalidating|terminating/i;

// Runs an optional extra (timer, activity, status page). A problem there is
// logged and must never stop the account from staying in the VC.
function safely(what, fn) {
  try {
    return fn();
  } catch (err) {
    log(`⚠️ ${what} problem (ignored): ${safeErr(err)}`);
    return undefined;
  }
}

let notReadySince = 0;

// Runs when the connection is usable again: after a brand-new login, and after
// the library resumes the same session following a dropped connection.
function onClientReady() {
  everReady = true;
  fatalReason = null;
  notReadySince = 0;

  // On a resume the account never left the channel, so what we know is still
  // true. A new session ID means Discord started us from scratch.
  const shard = bot.shards.get(0);
  const sessionId = shard ? shard.sessionID : null;
  const resumed = !!sessionId && sessionId === gatewaySessionId;
  gatewaySessionId = sessionId;

  if (resumed) {
    const here = getSelfVoiceChannelId();
    log(`🔄 Reconnected to the same session — ${here ? `still in ${describeChannel(here)}` : "not in a VC"}`);
  } else {
    // A fresh session never inherits the old one's voice state.
    selfVoice = null;
    ourVoiceSessionId = null;
    unconfirmedJoins = 0;
    if (targetChannelId) intentionalLeave = false;
    log(`✅ Logged in as ${bot.user.username} (${bot.user.id})`);
    log(
      `📡 In ${bot.guilds.size} server(s)` +
        (skippedChannels ? ` (ignored ${skippedChannels} forum/other non-voice channels Eris doesn't know)` : "")
    );
    skippedChannels = 0;
  }

  // Staying in the VC comes first; nothing below may get in its way.
  if (targetChannelId) {
    if (!intentionalLeave) joinVoice(); // does nothing if already there
  } else if (!resumed) {
    log("ℹ️ No VOICE_CHANNEL_ID set — staying online only.");
    const lines = listVoiceChannels();
    if (lines.length) {
      log(`📋 Voice channels (copy an ID and set VOICE_CHANNEL_ID or send "!join <id>"):\n${lines.join("\n")}`);
    }
  }
  startWatchdog();

  safely("status page", updateStatus);
  safely("activity", () => {
    lastPresence = null; // send the activity again
    syncTimerAndPresence();
    lookupApplication();
    checkActivityPrivacy();
  });
}

function clip(text, max = 300) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function main() {
  if (!TOKEN) {
    console.error(
      "❌ Missing Discord token. Set the `token` secret/env var to your user token.\n" +
        "   See README.md — step 3/4."
    );
    process.exit(1);
  }

  // Token sanity (never log the token itself).
  const tokenParts = TOKEN.split(".").length;
  log(`🔑 Token: length=${TOKEN.length} parts=${tokenParts} botPrefix=${TOKEN.startsWith("Bot ")}`);
  if (TOKEN.length < 50 || tokenParts !== 3) {
    log(
      "⚠️ Token looks wrong (a user token is ~70 characters in 3 dot-separated parts). " +
        "Re-copy it without quotes/spaces and update the `token` variable."
    );
  }
  log(
    `🎯 Config: VOICE_CHANNEL_ID=${targetChannelId || "(not set)"} ` +
      `mute=${SELF_MUTE} deaf=${SELF_DEAF} autoRejoin=${AUTO_REJOIN}`
  );
  if (targetChannelId && !/^\d{15,25}$/.test(targetChannelId)) {
    log("⚠️ VOICE_CHANNEL_ID should be only digits (right-click the voice channel > Copy Channel ID).");
  }

  vcTimer = createVcTimer({
    file: path.join(DATA_DIR, "vc-timer.json"),
    onError: (err) => log(`⚠️ VC timer storage problem (${DATA_DIR}): ${safeErr(err)}`),
  });
  log(
    `⏱️ VC timer: ${formatDuration(vcTimer.totalMs())} so far ` +
      `(${vcTimer.loaded ? "loaded from" : "new file at"} ${vcTimer.file})`
  );
  if (!HAS_PERSISTENT_DISK && ON_RAILWAY) {
    log(
      "⚠️ No Railway Volume attached — the VC timer will start from zero again on every redeploy. " +
        "Attach a Volume to this service (any mount path, e.g. /data) to keep the total."
    );
  }
  if (!vcTimer.save()) log("⚠️ VC timer cannot write its file — the total will not be kept.");
  log(
    `🎭 Activity: ${activityConfig.mode}, status ${STATUS}` +
      (activityConfig.appId ? `, application ${activityConfig.appId}` : ", no valid APPLICATION_ID (card disabled)")
  );

  if (process.env.COUNTDOWN_TO && !parseWhen(process.env.COUNTDOWN_TO, COUNTDOWN_OFFSET)) {
    log("⚠️ COUNTDOWN_TO could not be read as a date. Write it like 31-12-2026 23:59 — counting up instead.");
  } else if (countdownEnd()) {
    log(`⏳ Card clock counts down to ${whenText(countdownEnd())}`);
  }

  alerts = createAlerts({
    url: process.env.ALERT_WEBHOOK_URL,
    name: () => (bot && bot.user && bot.user.username) || "Account",
    log,
  });
  if (alerts.enabled) log("🔔 Alerts: on (posted to your channel webhook, not by the account)");
  else if (process.env.ALERT_WEBHOOK_URL) {
    log("⚠️ ALERT_WEBHOOK_URL is not a Discord webhook link (https://discord.com/api/webhooks/…) — alerts are off.");
  } else log("🔕 Alerts: off (set ALERT_WEBHOOK_URL to switch them on)");

  // Without this a user account logs in but Eris never reports "ready".
  applyUserAccountPatch();

  bot = new Eris(TOKEN, {
    autoreconnect: true,
    // Keep the gateway connection alive; Eris handles resume/reconnect.
    maxResumeAttempts: Infinity,
  });

  // Eris asks Discord's REST API for the gateway address before connecting.
  // If that request fails (cloud hosts are often rate-limited/blocked there),
  // Eris swallows the error and retries forever without logging anything —
  // the process just sits at "Connecting...". Log it and fall back to the
  // well-known gateway address so the login can still go ahead.
  const fetchGateway = bot.getGateway.bind(bot);
  bot.getGateway = async () => {
    try {
      const request = fetchGateway();
      request.catch(() => {}); // already handled below if it loses the race
      const data = await Promise.race([
        request,
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error("no response in 10s")), 10000);
          if (t.unref) t.unref();
        }),
      ]);
      if (!data || !data.url) throw new Error("empty response");
      return data;
    } catch (err) {
      log(
        `⚠️ Could not get the gateway address from Discord's API (${clip(safeErr(err))}) — ` +
          `falling back to ${DEFAULT_GATEWAY_URL}`
      );
      return { url: DEFAULT_GATEWAY_URL };
    }
  };

  // Gateway problems (bad token, timeouts, dropped sockets) arrive on these.
  bot.on("error", (err, id) => {
    const text = safeErr(err);
    log(`⚠️ Gateway error${id !== undefined ? ` (shard ${id})` : ""}: ${clip(text)}`);
    if (/invalid token|authentication failed/i.test(text)) {
      fatalReason = "Discord rejected the token (Authentication failed)";
      updateStatus();
      log(
        "❌ Discord rejected the token. It is wrong, expired, or was reset " +
          "(changing your password or logging out resets it). " +
          "Copy a fresh token and update the `token` variable, then redeploy."
      );
    }
  });
  bot.on("warn", (msg, id) => {
    const text = safeErr(msg);
    // Eris 0.17 doesn't know newer channel types (forums, media, ...) and warns
    // once per channel with a full data dump. Harmless — count them instead.
    if (!DEBUG && UNKNOWN_CHANNEL.test(text)) {
      skippedChannels++;
      return;
    }
    log(`⚠️ Gateway warning${id !== undefined ? ` (shard ${id})` : ""}: ${clip(text.split("\n")[0])}`);
  });

  // Login accepted by Discord. Eris should flag itself ready right after;
  // if it doesn't within a few seconds, push it over the line.
  bot.on("shardPreReady", (id) => {
    log(`🔓 Discord accepted the login (shard ${id})`);
    // Discord can replace our session on a live connection. The library then
    // logs in again but does not announce "ready" a second time, so the new
    // session (which is not in any voice channel) would go unnoticed.
    setImmediate(() => {
      const shard = bot.shards.get(id);
      if (bot.ready && shard && shard.sessionID && shard.sessionID !== gatewaySessionId) {
        log("🔁 Discord replaced the session — starting over");
        onClientReady();
      }
    });
    const t = setTimeout(() => {
      const shard = bot.shards.get(id);
      if (shard && !shard.ready && forceShardReady(shard)) {
        log(`⏩ Shard ${id} was stuck after login — forced ready`);
      }
    }, 5000);
    if (t.unref) t.unref();
  });
  bot.on("debug", (msg) => {
    const text = safeErr(msg);
    if (DEBUG || DEBUG_IMPORTANT.test(text)) log(`🐞 ${clip(text)}`);
  });
  bot.on("connect", (id) => log(`🔌 Gateway socket open (shard ${id}) — logging in...`));
  bot.on("shardResume", (id) => {
    if (DEBUG) log(`✅ Gateway session resumed (shard ${id})`);
    safely("activity", syncTimerAndPresence);
  });

  // Track our own voice state straight from the gateway.
  bot.on("rawWS", (packet) => {
    if (!packet || !packet.d) return;
    try {
      if (packet.t === "SESSIONS_REPLACE" || (packet.t === "READY" && Array.isArray(packet.d.sessions))) {
        const list = packet.t === "READY" ? packet.d.sessions : packet.d;
        if (Array.isArray(list)) knownSessionIds = new Set(list.map((x) => x && x.session_id).filter(Boolean));
      }
      if (packet.t === "SESSIONS_REPLACE") onSessions(packet.d);
      else if (packet.t === "READY" && Array.isArray(packet.d.sessions)) {
        const sessions = packet.d.sessions;
        setImmediate(() => safely("session report", () => onSessions(sessions)));
      }
      else if (packet.t === "USER_SETTINGS_UPDATE" && bot.userSettings) {
        Object.assign(bot.userSettings, packet.d);
        if (packet.d.show_current_game === true) privacyWarned = false;
        checkActivityPrivacy();
      }
    } catch (err) {
      log(`⚠️ Session report error: ${safeErr(err)}`);
    }
    if (packet.t !== "VOICE_STATE_UPDATE") return;
    if (!bot.user || packet.d.user_id !== bot.user.id) return;
    try {
      onSelfVoiceState(packet.d);
    } catch (err) {
      log(`⚠️ Voice state handler error: ${safeErr(err)}`);
    }
    safely("activity", syncTimerAndPresence);
  });

  bot.on("ready", onClientReady);

  bot.on("disconnect", () => {
    safely("activity", syncTimerAndPresence); // pauses the VC timer while the connection is down
    safely("status page", updateStatus);
  });

  bot.on("shardDisconnect", (err, id) => {
    log(`⚠️ Shard ${id} disconnected${err ? `: ${safeErr(err)}` : ""}`);
    updateStatus();
  });

  // Self-commands in DM or guild text channels.
  bot.on("messageCreate", (msg) => {
    if (!bot.user || !msg.author || msg.author.id !== bot.user.id) return;
    handleCommand(msg).catch((err) => {
      log(`⚠️ Command error: ${safeErr(err)}`);
    });
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (err) => log(`⚠️ Unhandled rejection: ${clip(safeErr(err))}`));
  process.on("uncaughtException", (err) => {
    log(`❌ Uncaught exception: ${safeErr(err && err.stack ? err.stack : err)}`);
    try {
      if (vcTimer) vcTimer.save();
    } catch {
      // ignore
    }
    process.exit(1);
  });

  // Keep the saved total fresh, and the shown time roughly current.
  const saveTick = setInterval(() => safely("VC timer", () => vcTimer.save()), 60000);
  if (saveTick.unref) saveTick.unref();
  const presenceTick = setInterval(() => {
    safely("activity", () => {
      lookupApplication();
      refreshPresence();
    });
  }, ACTIVITY_REFRESH);
  if (presenceTick.unref) presenceTick.unref();
  const alertTimer = setInterval(
    () => safely("alert", alertTick),
    Math.min(10000, Math.max(100, Math.floor(Math.min(ALERT_OFFLINE_AFTER, ALERT_VC_AFTER) / 4)))
  );
  if (alertTimer.unref) alertTimer.unref();

  log("🚀 Connecting to Discord...");

  // If login hangs, say so instead of sitting silent.
  const readyCheck = setInterval(() => {
    if (bot.ready) {
      notReadySince = 0;
      return;
    }
    if (!notReadySince) notReadySince = Date.now();
    // Some disconnects make the library give up instead of retrying. If we have
    // been offline for a while (and the token was not rejected), start over.
    if (!fatalReason && Date.now() - notReadySince >= RECONNECT_AFTER) {
      notReadySince = Date.now();
      log("♻️ Offline for too long — starting a fresh connection to Discord");
      safely("reconnect", () => {
        for (const shard of bot.shards.values()) shard.disconnect({ reconnect: false });
        bot.connect().catch((err) => log(`❌ Reconnect failed: ${clip(safeErr(err))}`));
      });
      return;
    }
    const shardInfo = [...bot.shards.values()].map((s) => `shard ${s.id}: ${s.status}`).join(", ");
    log(
      fatalReason
        ? `❌ Not logged in: ${fatalReason}. Fix the \`token\` variable and redeploy.`
        : `⏳ Not logged in yet (${shardInfo || "no gateway connection"}). Eris keeps retrying — see any errors above.`
    );
  }, READY_TIMEOUT);
  if (readyCheck.unref) readyCheck.unref();

  bot.connect().catch((err) => {
    log(`❌ Initial connect failed (could not reach Discord's gateway endpoint): ${clip(safeErr(err))}`);
  });
}

function shutdown() {
  log("🛑 Shutting down...");
  if (watchdogTimer) clearInterval(watchdogTimer);
  if (rejoinTimer) clearTimeout(rejoinTimer);
  intentionalLeave = true;
  try {
    if (vcTimer) {
      vcTimer.stop();
      vcTimer.save();
    }
  } catch {
    // ignore
  }
  try {
    if (bot && selfVoice && !heldByOtherDevice()) sendVoiceState(selfVoice.guildId, null);
  } catch {
    // ignore
  }
  // Give the leave message a moment to flush before closing the socket.
  setTimeout(() => {
    try {
      if (bot) bot.disconnect({ reconnect: false });
    } catch {
      // ignore
    }
    process.exit(0);
  }, 300);
}

main();
