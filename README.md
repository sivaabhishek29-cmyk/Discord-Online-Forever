# Discord-Online-Forever

Keep your Discord profile online forever **and stay in a voice channel**.

## Setup

### Railway (recommended)

1. Create a new Railway project from this GitHub repo. Railway auto-detects Node via `railway.toml` in this repo:
   - Build Command: `npm ci`
   - Start Command: `npm start`
2. In Railway → **Variables**, add:
   - `token` = your Discord user token
   - `VOICE_CHANNEL_ID` = the voice channel ID (see step 5 below)
3. Redeploy. Check **Deployments → Logs** (not Console) — you should see `✅ Logged in as ...` and `✅ Joined #...`.
   - Do **not** type `npm start` in the Console tab — Console is just a debug shell. The app starts automatically via the Start Command.

### Replit / local

1. Register Replit - https://Replit.com
2. Run on Replit - https://replit.com/new/github/Gunthersuper/Discord-Online-Forever
   (or clone this repo and run `npm install && npm start` anywhere)
3. Get Token of your Discord:
   - Login to your Discord in the browser
   - Press: CTRL+SHIFT+I or F12. Go to Network. Click some dialogue or some server
   - Find `science`. Go to Headers. In request headers find: `authorization`. Copy this token
4. Go to replit, secrets. make new secret. Key is `token`, and value is your token
5. Get the Voice Channel ID you want to stay in:
   - Discord Settings > Advanced > turn **Developer Mode** ON
   - Right-click the voice channel > **Copy Channel ID**
6. Go to replit, secrets. make new secret. Key is `VOICE_CHANNEL_ID`, and value is the channel ID from step 5
7. Run the bot (`npm start` or the Run button)
8. Go to https://uptimerobot.com, register. Click: Add new monitor
9. Monitor type is HTTP. Url is address you get on replit. Click create monitor (2 times)
10. Make sure the last session you was online

## How staying in VC works

- On startup the account joins `VOICE_CHANNEL_ID` muted + deafened (`SELF_MUTE=true`, `SELF_DEAF=true`).
- If you get kicked, moved to another VC, or the voice/gateway connection drops, it auto-rejoins after `REJOIN_DELAY` ms (default 5000).
- A watchdog checks every `WATCHDOG_INTERVAL` ms (default 30000) and rejoins if you're not in the target VC.
- If you unmute/un-deafen yourself, it re-applies mute/deafen.

## Config (env vars / secrets)

| Key | Required | Default | Description |
| --- | --- | --- | --- |
| `token` | yes | — | Your Discord user token (aliases: `TOKEN`, `DISCORD_TOKEN`) |
| `VOICE_CHANNEL_ID` | no* | — | Voice channel ID to join & stay in (aliases: `VC_ID`, `CHANNEL_ID`) |
| `GUILD_ID` | no | — | Server ID, only used for logging/validation |
| `SELF_MUTE` | no | `true` | Join muted |
| `SELF_DEAF` | no | `true` | Join deafened |
| `AUTO_REJOIN` | no | `true` | Rejoin when kicked/moved/disconnected |
| `REJOIN_DELAY` | no | `5000` | Ms to wait before rejoining |
| `WATCHDOG_INTERVAL` | no | `30000` | Ms between stay-checks |
| `COMMAND_PREFIX` | no | `!` | Prefix for self-commands |

\* If `VOICE_CHANNEL_ID` is not set, the bot stays online only and logs all voice channels so you can copy an ID. You can also join later with `!join <channelId>` (see below) without restarting.

See `.env.example` for a copy-paste template.

## Self-commands

Send these from your own account (DM or any text channel). Only your own messages trigger them.

- `!join <channelId>` — join a VC and stay there (accepts `<#id>` mentions too)
- `!join` — rejoin the current target VC
- `!leave` — leave VC and pause auto-rejoin until next `!join`
- `!status` — show current VC / target / connection state
- `!vcs` — list all voice channels with IDs
- `!help` — show help

## Troubleshooting

- `npm: command not found` on Railway — Railway didn't install Node. This repo now includes `railway.toml` (Nixpacks builder, `npm ci` build, `npm start` start) plus a `Dockerfile` (`node:20-alpine`) as fallback. Push/redeploy so Railway picks them up. In Railway → Settings → Build, make sure Builder is **Nixpacks** (or **Docker** with the included Dockerfile) and Start Command is `npm start`. Check **Deployments → Logs**, not Console.
- `Voice channel ... not found` — the account isn't in that server, or the ID is wrong. Run `!vcs` to list valid IDs.
- `Insufficient permission to connect` — the channel is locked / you lack Connect permission.
- `Voice connection timeout` — Discord didn't answer; the bot retries automatically. Check your internet / host logs.
- Bot goes offline — check the keep-alive URL with UptimeRobot and the host logs. The `keep_alive.js` server listens on `PORT` (default 8080) and answers `I'm alive` at `/`.
