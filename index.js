const Eris = require("eris");
const keepAlive = require("./keep_alive.js");
const path = require("path");
const { applyUserAccountPatch, forceShardReady } = require("./eris_user_patch.js");
const { createVcTimer, formatDuration } = require("./vc_timer.js");
const { buildActivities, fetchApplication, pickAsset } = require("./activity.js");

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
const activityConfig = {
  mode: ACTIVITY_MODE,
  appId: /^\d{15,25}$/.test(APPLICATION_ID) ? APPLICATION_ID : null,
  appName: process.env.ACTIVITY_NAME || null, // filled in from Discord if not set
  imageId: null, // filled in from the application's uploaded images
  customText: process.env.CUSTOM_STATUS || DEFAULT_CUSTOM_TEXT,
  customTextIdle: "Total VC time: {total}",
  customEmoji: process.env.CUSTOM_STATUS_EMOJI === undefined ? "🎧" : process.env.CUSTOM_STATUS_EMOJI,
  details: process.env.ACTIVITY_DETAILS || "Chilling in {channel}",
  detailsIdle: "Not in voice right now",
  state: process.env.ACTIVITY_STATE || "Total VC time: {total}",
};
const ACTIVITY_IMAGE = process.env.ACTIVITY_IMAGE || "";
const ACTIVITY_REFRESH = parseIntEnv(process.env.ACTIVITY_REFRESH, 300000);
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
let vcTimer = null; // created in main()
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
function sendVoiceState(guildId, channelId) {
  const shardId = (bot.guildShardMap && bot.guildShardMap[guildId]) || 0;
  const shard = bot.shards.get(shardId);
  if (!shard) return false;
  shard.sendWS(GATEWAY_OP_VOICE_STATE_UPDATE, {
    guild_id: guildId,
    channel_id: channelId || null,
    self_mute: SELF_MUTE,
    self_deaf: SELF_DEAF,
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
  log(`🔁 Will rejoin ${describeChannel(targetChannelId)} in ${REJOIN_DELAY}ms (${reason})`);
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null;
    if (intentionalLeave || heldByOtherDevice()) return;
    joinVoice();
  }, REJOIN_DELAY);
  // Don't keep the process alive just for this timer.
  if (rejoinTimer.unref) rejoinTimer.unref();
}

// Every VOICE_STATE_UPDATE about our own account lands here.
function onSelfVoiceState(d) {
  const previous = selfVoice;

  if (!d.channel_id) {
    // Only a "left" for the guild we were in (or if we weren't tracked at all).
    if (previous && d.guild_id && previous.guildId !== d.guild_id) return;
    selfVoice = null;
    updateStatus();
    if (previous) {
      log(`⚠️ No longer in ${describeChannel(previous.channelId)} (kicked, disconnected or left)`);
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
    }
    return;
  }

  if (targetChannelId && d.channel_id !== targetChannelId) {
    if (!previous || previous.channelId !== d.channel_id) {
      log(`⚠️ Moved to ${describeChannel(d.channel_id)} — going back to target`);
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
      if (!sendVoiceState(guildId, channelId)) resolve(false);
    });
    pendingJoin = null;

    if (confirmed) {
      log(`✅ Joined ${describeChannel(channelId)} — staying here`);
      return true;
    }
    log(
      `❌ Discord did not confirm joining ${describeChannel(channelId)} within ${JOIN_CONFIRM_TIMEOUT}ms. ` +
        "Usual causes: no Connect permission, channel is full, or wrong channel ID."
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
    if (heldByOtherDevice()) return;
    const currentId = getSelfVoiceChannelId();
    if (currentId !== targetChannelId) {
      log(
        `🐕 Watchdog: currently in ${currentId ? describeChannel(currentId) : "no VC"}, ` +
          `expected ${describeChannel(targetChannelId)} — rejoining`
      );
      joinVoice();
    } else {
      ensureMuteDeaf();
    }
  }, WATCHDOG_INTERVAL);
  if (watchdogTimer.unref) watchdogTimer.unref();
  log(`🐕 Watchdog started (every ${WATCHDOG_INTERVAL}ms)`);
}

// ---------------------------------------------------------------------------
// VC timer + activity
// ---------------------------------------------------------------------------
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
          total: formatDuration(vcTimer.totalMs()),
          stay: formatDuration(vcTimer.stayMs()),
          stayStart: vcTimer.stayStart(),
        })
      : [];
    const payload = JSON.stringify([STATUS, activities]);
    if (payload === lastPresence) return;
    lastPresence = payload;
    bot.editStatus(STATUS, activities);

    // Log when the kind of activity changes, not on every time tick.
    const shape = `${activities.map((a) => a.type).join(",")}|${inVoice}|${cfg.customText}|${cfg.appName}|${cfg.imageId}`;
    if (shape !== lastPresenceShape || DEBUG) {
      lastPresenceShape = shape;
      if (!activities.length) {
        log(`🎭 Activity cleared (status: ${STATUS})`);
      } else {
        const parts = activities.map((a) =>
          a.type === 4
            ? `custom status "${a.emoji ? `${a.emoji.name} ` : ""}${a.state}"`
            : `card "${a.name}" — ${a.details} / ${a.state}${a.assets ? " (with image)" : " (no image)"}`
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
    log(`✅ Gateway session resumed (shard ${id})`);
    syncTimerAndPresence();
  });

  // Track our own voice state straight from the gateway.
  bot.on("rawWS", (packet) => {
    if (!packet || packet.t !== "VOICE_STATE_UPDATE" || !packet.d) return;
    if (!bot.user || packet.d.user_id !== bot.user.id) return;
    try {
      onSelfVoiceState(packet.d);
    } catch (err) {
      log(`⚠️ Voice state handler error: ${safeErr(err)}`);
    }
    syncTimerAndPresence();
  });

  bot.on("ready", () => {
    everReady = true;
    fatalReason = null;
    // A fresh session never inherits the old one's voice state.
    selfVoice = null;
    ourVoiceSessionId = null;
    lastPresence = null; // new session: send the activity again
    syncTimerAndPresence();
    lookupApplication();
    log(`✅ Logged in as ${bot.user.username} (${bot.user.id})`);
    log(
      `📡 In ${bot.guilds.size} server(s)` +
        (skippedChannels ? ` (ignored ${skippedChannels} forum/other non-voice channels Eris doesn't know)` : "")
    );
    skippedChannels = 0;
    updateStatus();
    if (targetChannelId) {
      intentionalLeave = false;
      joinVoice();
    } else {
      log("ℹ️ No VOICE_CHANNEL_ID set — staying online only.");
      const lines = listVoiceChannels();
      if (lines.length) {
        log(`📋 Voice channels (copy an ID and set VOICE_CHANNEL_ID or send "!join <id>"):\n${lines.join("\n")}`);
      }
    }
    startWatchdog();
  });

  bot.on("disconnect", () => {
    syncTimerAndPresence(); // pauses the VC timer while the connection is down
    updateStatus();
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
  const saveTick = setInterval(() => vcTimer.save(), 60000);
  if (saveTick.unref) saveTick.unref();
  const presenceTick = setInterval(() => {
    lookupApplication();
    refreshPresence();
  }, ACTIVITY_REFRESH);
  if (presenceTick.unref) presenceTick.unref();

  log("🚀 Connecting to Discord...");

  // If login hangs, say so instead of sitting silent.
  const readyCheck = setInterval(() => {
    if (bot.ready) return;
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
