const Eris = require("eris");
require("./keep_alive.js");

// ---------------------------------------------------------------------------
// Config (env vars)
// ---------------------------------------------------------------------------
// Token: supports the original `token` name plus common aliases.
const TOKEN =
  process.env.token || process.env.TOKEN || process.env.DISCORD_TOKEN || "";

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

// Stay muted/deafened so the account sits silently in VC.
const SELF_MUTE = parseBool(process.env.SELF_MUTE, true);
const SELF_DEAF = parseBool(
  process.env.SELF_DEAF ?? process.env.SELF_DEAFEN,
  true
);

// Auto-rejoin when kicked / moved / disconnected.
const AUTO_REJOIN = parseBool(process.env.AUTO_REJOIN, true);
const REJOIN_DELAY = parseIntEnv(process.env.REJOIN_DELAY, 5000);
const WATCHDOG_INTERVAL = parseIntEnv(process.env.WATCHDOG_INTERVAL, 30000);
const COMMAND_PREFIX = process.env.COMMAND_PREFIX || "!";

// Eris channel types: 2 = GUILD_VOICE, 13 = GUILD_STAGE_VOICE
const VOICE_TYPES = new Set([2, 13]);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let bot = null;
let currentConnection = null; // Eris VoiceConnection (or null)
let joining = false; // guard against concurrent join attempts
let intentionalLeave = false; // true after `!leave` until next `!join`
let rejoinTimer = null;
let watchdogTimer = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getSelfVoiceState() {
  if (!bot || !bot.user) return null;
  for (const guild of bot.guilds.values()) {
    const vs = guild.voiceStates.get(bot.user.id);
    if (vs && vs.channelID) return vs;
  }
  return null;
}

function getSelfVoiceChannelId() {
  const vs = getSelfVoiceState();
  return vs ? vs.channelID : null;
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

function ensureMuteDeaf() {
  if (!currentConnection || !currentConnection.ready) return;
  const vs = getSelfVoiceState();
  if (!vs) return;
  if (vs.selfMute !== SELF_MUTE || vs.selfDeaf !== SELF_DEAF) {
    log(`🔇 Re-applying mute=${SELF_MUTE} deaf=${SELF_DEAF}`);
    currentConnection.updateVoiceState(SELF_MUTE, SELF_DEAF);
  }
}

function scheduleRejoin(reason) {
  if (!AUTO_REJOIN) return;
  if (intentionalLeave) return;
  if (!targetChannelId) return;
  if (rejoinTimer) return; // already scheduled
  log(`🔁 Will rejoin ${describeChannel(targetChannelId)} in ${REJOIN_DELAY}ms (${reason})`);
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null;
    joinVoice();
  }, REJOIN_DELAY);
  // Don't keep the process alive just for this timer.
  if (rejoinTimer.unref) rejoinTimer.unref();
}

function attachConnectionHandlers(conn) {
  if (!conn || conn._stayHandlersAttached) return;
  conn._stayHandlersAttached = true;

  conn.on("ready", () => {
    log(`✅ Voice connection ready in ${describeChannel(conn.channelID || targetChannelId)}`);
    ensureMuteDeaf();
  });

  conn.on("disconnect", (err) => {
    log(`⚠️ Voice connection disconnected${err ? `: ${err.message || err}` : ""}`);
    if (currentConnection === conn) currentConnection = null;
    scheduleRejoin("voice disconnect");
  });

  conn.on("error", (err) => {
    log(`⚠️ Voice connection error: ${err && err.message ? err.message : err}`);
  });
}

async function joinVoice(channelId = targetChannelId) {
  if (!channelId) {
    log("ℹ️ No VOICE_CHANNEL_ID set — staying online only. Send `!join <channelId>` in DM to join a VC.");
    return null;
  }
  if (!bot || !bot.ready) {
    log("ℹ️ Not ready yet — will join once connected.");
    return null;
  }
  if (joining) return currentConnection;

  // Already in the target channel with a live connection.
  const currentId = getSelfVoiceChannelId();
  if (currentId === channelId && currentConnection && currentConnection.ready) {
    return currentConnection;
  }

  const channel = bot.getChannel(channelId);
  if (!channel) {
    log(
      `❌ Voice channel ${channelId} not found. Is the account in that server? ` +
        `Available VCs:\n${listVoiceChannels().join("\n") || "  (none)"}`
    );
    scheduleRejoin("channel not found");
    return null;
  }
  if (!VOICE_TYPES.has(channel.type)) {
    log(`❌ Channel ${describeChannel(channelId)} is not a voice channel (type=${channel.type}).`);
    return null;
  }
  if (targetGuildId && channel.guild && channel.guild.id !== targetGuildId) {
    log(`⚠️ Channel is in guild ${channel.guild.id}, expected GUILD_ID=${targetGuildId}. Joining anyway.`);
  }

  joining = true;
  try {
    log(`🎧 Joining ${describeChannel(channelId)} (mute=${SELF_MUTE} deaf=${SELF_DEAF})...`);
    const conn = await bot.joinVoiceChannel(channelId, {
      selfMute: SELF_MUTE,
      selfDeaf: SELF_DEAF,
    });
    currentConnection = conn;
    attachConnectionHandlers(conn);
    log(`✅ Joined ${describeChannel(channelId)}`);
    return conn;
  } catch (err) {
    log(`❌ Failed to join ${describeChannel(channelId)}: ${err && err.message ? err.message : err}`);
    scheduleRejoin(`join failed: ${err && err.message ? err.message : err}`);
    return null;
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
  const currentId = getSelfVoiceChannelId();
  try {
    if (currentId) bot.leaveVoiceChannel(currentId);
  } catch (err) {
    log(`⚠️ leaveVoiceChannel error: ${err && err.message ? err.message : err}`);
  }
  if (currentConnection) {
    try {
      currentConnection.disconnect();
    } catch {
      // ignore
    }
    currentConnection = null;
  }
  log("👋 Left voice channel (auto-rejoin paused until `!join`)");
}

function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (!bot || !bot.ready || !targetChannelId) return;
    if (intentionalLeave || !AUTO_REJOIN) return;
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
    log(`⚠️ Failed to reply: ${err && err.message ? err.message : err}`);
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

  if (cmd === "status") {
    const currentId = getSelfVoiceChannelId();
    const connState = currentConnection
      ? `ready=${!!currentConnection.ready} connecting=${!!currentConnection.connecting} channel=${currentConnection.channelID || "none"}`
      : "none";
    await reply(
      msg,
      [
        `User: ${bot.user.username}#${bot.user.discriminator} (${bot.user.id})`,
        `Current VC: ${currentId ? describeChannel(currentId) : "none"}`,
        `Target VC: ${targetChannelId ? describeChannel(targetChannelId) : "not set (use !join <id>)"}`,
        `Voice connection: ${connState}`,
        `Auto-rejoin: ${AUTO_REJOIN} (paused=${intentionalLeave})`,
        `Mute/deaf: ${SELF_MUTE}/${SELF_DEAF}`,
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
function main() {
  if (!TOKEN) {
    console.error(
      "❌ Missing Discord token. Set the `token` secret/env var to your user token.\n" +
        "   See README.md — step 3/4."
    );
    process.exit(1);
  }

  bot = new Eris(TOKEN, {
    autoreconnect: true,
    // Keep the gateway connection alive; Eris handles resume/reconnect.
    maxResumeAttempts: Infinity,
  });

  bot.on("error", (err) => {
    log(`⚠️ Client error: ${err && err.message ? err.message : err}`);
  });

  bot.on("ready", () => {
    log(`✅ Logged in as ${bot.user.username}#${bot.user.discriminator} (${bot.user.id})`);
    log(`📡 In ${bot.guilds.size} guild(s)`);
    if (targetChannelId) {
      log(`🎯 Target VC: ${describeChannel(targetChannelId)}`);
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
    log("⚠️ Gateway disconnected — will rejoin VC on next ready.");
    currentConnection = null;
  });

  bot.on("shardDisconnect", (err, id) => {
    log(`⚠️ Shard ${id} disconnected${err ? `: ${err.message || err}` : ""}`);
  });

  // Kicked / left / channel deleted → rejoin.
  bot.on("voiceChannelLeave", (member, channel) => {
    if (!bot.user || !member || member.id !== bot.user.id) return;
    log(`⚠️ Self left ${describeChannel(channel.id)}`);
    scheduleRejoin("voiceChannelLeave");
  });

  // Moved to a different VC → come back to target.
  bot.on("voiceChannelSwitch", (member, newChannel, oldChannel) => {
    if (!bot.user || !member || member.id !== bot.user.id) return;
    log(`⚠️ Self switched ${describeChannel(oldChannel.id)} → ${describeChannel(newChannel.id)}`);
    if (targetChannelId && newChannel.id !== targetChannelId) {
      scheduleRejoin("voiceChannelSwitch");
    }
  });

  // Someone unmutes/un-deafens us → re-apply.
  bot.on("voiceStateUpdate", (member) => {
    if (!bot.user || !member || member.id !== bot.user.id) return;
    ensureMuteDeaf();
  });

  // Self-commands in DM or guild text channels.
  bot.on("messageCreate", (msg) => {
    if (!bot.user || !msg.author || msg.author.id !== bot.user.id) return;
    handleCommand(msg).catch((err) => {
      log(`⚠️ Command error: ${err && err.message ? err.message : err}`);
    });
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log("🚀 Connecting to Discord...");
  bot.connect().catch((err) => {
    log(`❌ Initial connect failed: ${err && err.message ? err.message : err}`);
  });
}

function shutdown() {
  log("🛑 Shutting down...");
  if (watchdogTimer) clearInterval(watchdogTimer);
  if (rejoinTimer) clearTimeout(rejoinTimer);
  try {
    const currentId = bot ? getSelfVoiceChannelId() : null;
    if (bot && currentId) bot.leaveVoiceChannel(currentId);
  } catch {
    // ignore
  }
  try {
    if (bot) bot.disconnect();
  } catch {
    // ignore
  }
  process.exit(0);
}

main();
