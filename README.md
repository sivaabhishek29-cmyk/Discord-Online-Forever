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

- On startup the account joins `VOICE_CHANNEL_ID` with the mic on and deafened (`SELF_MUTE=false`, `SELF_DEAF=true`). Set `SELF_MUTE=true` to show as muted, or `SELF_DEAF=false` to show as not deafened.
- It joins with a plain gateway message only — no audio connection is opened, so nothing is sent or received. "Mic on" only changes the icon others see; no sound is transmitted.
- If you get kicked, moved to another VC, or the gateway reconnects, it rejoins after `REJOIN_DELAY` ms (default 5000).
- A watchdog checks every `WATCHDOG_INTERVAL` ms (default 30000) and rejoins if you're not in the target VC.
- If your mute/deafen state changes, it re-applies it.
- Every `REASSERT_INTERVAL` ms (default 300000) it repeats "I'm in this channel" to Discord. That changes nothing while the account is there, and puts it back if it was dropped without notice.
- When the connection to Discord drops and resumes, the account is still treated as in the channel (no leave/rejoin). If Discord hands out a brand-new session, or the library gives up reconnecting, the app starts over and rejoins by itself.
- If you join voice yourself from your phone or PC, it does not fight you: it waits and rejoins the target VC when that device leaves voice. (Discord allows one voice session per account, so the first join after a restart does take voice over from another device.)

## LIVE badge

After joining, the account asks Discord to mark it as streaming, which puts the red **LIVE** badge next to its name in the voice channel. Like the mic icon, it is only the badge: no picture is sent, so anyone who taps the stream gets an endless loading screen.

- If the badge goes away it is asked for again after `LIVE_RETRY`. After five misses in a row the app slows down to 15 times that wait and says so in the log (and in the alerts channel).
- If Discord refuses it (the account lacks the **Video** permission in the channel), the log says so and it is tried again only after the next join.
- Stage channels have no Go Live, so nothing is asked for there.
- `!live` shows whether the badge is on; `!live off` removes it, `!live on` asks for it again. `LIVE=off` removes the feature.

Announcing a stream that carries nothing is one more automated action that Discord can notice on a user account.

## Purple streaming dot

The account also shows a "Streaming" entry, which turns the dot on its profile picture purple. Discord only does this for a Twitch or YouTube link, so the entry carries one (`STREAM_URL`); people who tap **Watch** are taken to that link.

- `STREAM_TITLE` is the text shown after "Streaming".
- `!purple` shows whether it is on; `!purple off` / `!purple on` switch it. `STREAMING=off` removes the feature.
- If Discord does not keep the entry, the log says `Discord dropped the "Streaming" entry`.

## VC timer

The app counts how long the account has been in voice and keeps a running total.

- See it with `!timer`, in `!status`, on the keep-alive URL at `/health`, and in the activity under the account's name.
- The total is saved to `vc-timer.json`. To keep it across redeploys the file must live on persistent storage:
  **Railway → your project → Create → Volume → attach it to this service → mount path `/data`.** Nothing else to set; the app finds the volume by itself. Without a volume the total starts from zero on every redeploy (the logs warn about this).
- On other hosts, set `DATA_DIR` to a folder that survives restarts.

## Activity (what shows under the account's name)

By default the account shows three things:

- a **custom status**: `🎧 In VC for 09d-14h-47m`
- a **Rich Presence card** from your Discord application (`APPLICATION_ID`): `Competing in <app name>`, `Chilling with Alya 🩷🎀`, `dev Lovelycrxshx ♠`, a clock that reads the time of day in India, ticking every second, and two buttons (`Self-run acc, not a real user`, `Contact Admin`) that open a Discord profile
- a **second card** from a second application (`CARD2_APPLICATION_ID`): `Listening to <app name>`, `Active Intervel 🦈`, `Day 1`, and a bar such as `05:35:12 ▬●───── 23:56:04` that moves by itself, whose left-hand figure is the time of day in India

The clock is drawn by Discord on the viewer's screen, so it moves every second without the app sending anything. The custom status is re-sent once a minute with the current days, hours and minutes. `ACTIVITY_REFRESH` can lower that to 5000 (every 5 seconds, with seconds shown: `09d-14h-47m-54s`), which is the fastest Discord permits, but constant status changes make the account look automated.

### The clock on the first card

`ACTIVITY_CLOCK` picks what it shows: `time` (the time of day, started at local midnight, so it needs one update a day), `total` (lifetime VC time) or `stay` (the current stay). Discord puts no label on the clock. `TIME_OFFSET` sets the time zone (default `+05:30`, India).

### Second card (bar)

The bar is the kind Discord draws for a song: it gets a start and an end time once and then moves on the viewer's screen, so nothing is re-sent while it runs. It only exists for the wordings `listening` and `watching`. `CARD2_BAR` picks what it follows:

- `time` (default): the bar starts at local midnight (`TIME_OFFSET`, India by default), so its left-hand figure is the time of day. It is re-sent once a day, at midnight, and shows in and out of voice.
- `level`: the bar fills once per level of voice time and is only shown while the account is in voice, because it cannot be paused.

`LEVEL_TIME` is the bar's full length, the figure on its right. The default is `23:56:04`, the exact length of a day (one full turn of the Earth) rather than a rounded 24 hours; with the `time` bar that means it sits full for the last four minutes before midnight. `{level}` counts completed stretches of `LEVEL_TIME` in voice, plus one.

`{day}` is a day counter: `DAY_ONE` (default `26-11-2026`) is day 1 and the number goes up at each local midnight. `!day` shows it, `!day 5` makes today day 5, `!day reset` goes back to `DAY_ONE`.

The card's title and picture come from its own application, the same way as the first card's (`CARD2_IMAGE` picks an image by name). Text can use `{day}`, `{level}`, `{level_time}`, `{channel}`, `{server}` and `{total}`; a line set to nothing is not shown. `CARD2=off` removes the card. Small views such as the member list show only one card; the full profile shows both. If the log says `Discord is showing 1 of the 2 cards`, Discord refused the second one.

### Countdown

The card's clock can count **down** to a date and time instead of counting up. From the account itself send `!countdown 31-12-2026 23:59` (India time unless you add a zone such as `+00:00`), or set the `COUNTDOWN_TO` variable. `!countdown` shows what is running, `!countdown off` goes back to counting up. When the moment passes, the clock counts up again by itself.

The card's picture is the first image uploaded to the application (Developer Portal → your app → Rich Presence → Art Assets). The App Icon on the General Information page is a different thing and is not used. Set `ACTIVITY_IMAGE` to an asset name to pick another. With no images uploaded the card shows without a picture.

The applications are read again every 15 minutes (every 5 while a picture is missing), so a picture uploaded later appears by itself; Discord can take several minutes to publish a new one. `!reload` from the account reads them straight away, says what it found for each card, and sends the cards again.

The card can have up to two link buttons (`BUTTON1_LABEL` + `BUTTON1_URL`, `BUTTON2_LABEL` + `BUTTON2_URL`). Discord does not show your own buttons to you: check them from another account. A link to a Discord profile is `https://discord.com/users/<user id>`.

Text can use `{total}` (lifetime VC time), `{stay}` (current stay), `{channel}` and `{server}`.

## Alerts

Set `ALERT_WEBHOOK_URL` to a Discord channel webhook link and that channel gets a short message when the account:

- comes online after a start or redeploy (`🟢 Online`)
- is kicked or disconnected from the voice channel, or moved to another one, and again when it is back (`⚠️ Removed from #General…`, `✅ Back in #General after 6s`)
- has been outside the voice channel for 2 minutes
- has been offline for 1 minute, and again when it returns (`🔴 Offline…`, `🟢 Back online after 3m 5s`)
- has its voice taken over by another device
- has its token rejected (`❌ Discord rejected the token…`)

The messages are posted by the server straight to the webhook. The account's token is not used and the account itself sends nothing. At most 8 alerts go out per 10 minutes.

To get the link: in your own server, open the channel's settings → **Integrations** → **Webhooks** → **New Webhook** → **Copy Webhook URL**. Put it only in the host's variables: anyone who has the link can post in that channel, so never commit it or share it.

## Config (env vars / secrets)

| Key | Required | Default | Description |
| --- | --- | --- | --- |
| `token` | yes | — | Your Discord user token (aliases: `TOKEN`, `DISCORD_TOKEN`) |
| `VOICE_CHANNEL_ID` | no* | — | Voice channel ID to join & stay in (aliases: `VC_ID`, `CHANNEL_ID`) |
| `GUILD_ID` | no | — | Server ID. Normally not needed; set it if the logs say the channel was not found |
| `SELF_MUTE` | no | `false` | `false` = mic shown on, `true` = shown muted |
| `SELF_DEAF` | no | `true` | `true` = shown deafened, `false` = not deafened |
| `LIVE` | no | `on` | Show the LIVE (streaming) badge in the voice channel. `off` removes it |
| `STREAMING` | no | `on` | Purple streaming dot on the profile picture. `off` keeps the normal dot |
| `STREAM_URL` | no | `https://www.twitch.tv/discord` | Link behind the Watch button. Must be a Twitch or YouTube link |
| `STREAM_TITLE` | no | `Live 24/7 🔴` | Text shown after "Streaming" |
| `LIVE_RETRY` | no | `120000` | Ms to wait before asking for the badge again when it is not showing |
| `AUTO_REJOIN` | no | `true` | Rejoin when kicked/moved/disconnected |
| `REJOIN_DELAY` | no | `5000` | Ms to wait before rejoining |
| `WATCHDOG_INTERVAL` | no | `30000` | Ms between stay-checks |
| `REASSERT_INTERVAL` | no | `300000` | Ms between repeats of "I'm in this channel" |
| `COMMAND_PREFIX` | no | `!` | Prefix for self-commands |
| `ACTIVITY` | no | `both` | `both`, `custom` (status line only), `rich` (card only) or `off` |
| `ACTIVITY_TYPE` | no | `competing` | Wording on the card: `playing`, `listening`, `watching` or `competing` |
| `STATUS` | no | `online` | `online`, `idle`, `dnd` or `invisible` |
| `APPLICATION_ID` | no | built in | Discord application used for the card |
| `CUSTOM_STATUS` | no | `In VC for {total}` | Custom status text |
| `CUSTOM_STATUS_EMOJI` | no | `🎧` | Emoji in front of the custom status (empty for none) |
| `ACTIVITY_DETAILS` | no | `Chilling with Alya 🩷🎀` | First line of the card |
| `ACTIVITY_STATE` | no | `dev Lovelycrxshx ♠` | Second line of the card |
| `BUTTON1_LABEL` | no | `Self-run acc, not a real user` | Text on the first button (max 32 characters). `off` removes the button |
| `BUTTON1_URL` | no | `https://discord.com/users/825998094067695616` | Link the first button opens |
| `BUTTON2_LABEL` | no | `Contact Admin` | Text on the second button. `off` removes the button |
| `BUTTON2_URL` | no | `https://discord.com/users/825998094067695616` | Link the second button opens |
| `ACTIVITY_IMAGE` | no | first image | Name of the application image to show |
| `ACTIVITY_NAME` | no | app's name | Title of the card |
| `ACTIVITY_CLOCK` | no | `time` | What the first card's ticking clock shows: `time` (time of day), `total` (lifetime VC time) or `stay` (current stay) |
| `TIME_OFFSET` | no | `+05:30` | Time zone for the time-of-day clock and for countdown dates |
| `CARD2` | no | `on` | `off` removes the second card |
| `CARD2_TYPE` | no | `listening` | Wording of the second card: `listening` or `watching` |
| `CARD2_APPLICATION_ID` | no | `1575297984684363846` | Discord application of the second card |
| `CARD2_NAME` | no | app's name | Title of the second card |
| `CARD2_IMAGE` | no | first image | Name of the second application's image to show |
| `CARD2_DETAILS` | no | `Active Intervel 🦈` | First line of the second card |
| `CARD2_STATE` | no | `Day {day}` | Second line of the second card (empty for none) |
| `DAY_ONE` | no | `26-11-2026` | The date that counts as day 1 for `{day}` |
| `CARD2_BAR` | no | `time` | What the bar follows: `time` (time of day) or `level` (voice time) |
| `LEVEL_TIME` | no | `23:56:04` | Full length of the bar (and voice time per level), as `HH:MM:SS` |
| `ACTIVITY_REFRESH` | no | `60000` | Ms between updates of the time shown as text (5000 is the minimum; below 30000 the text also shows seconds) |
| `COUNTDOWN_TO` | no | — | Date and time the card's clock counts down to, e.g. `31-12-2026 23:59` |
| `ALERT_WEBHOOK_URL` | no | — | Discord channel webhook link for alerts (see Alerts). Keep it secret |
| `ALERT_OFFLINE_AFTER` | no | `60000` | Ms offline before the "offline" alert |
| `ALERT_VC_AFTER` | no | `120000` | Ms outside the voice channel before the "not in channel" alert |
| `DATA_DIR` | no | Railway volume, else `./data` | Folder for `vc-timer.json` |
| `DEBUG` | no | `false` | Log every gateway message (noisy) |

\* If `VOICE_CHANNEL_ID` is not set, the bot stays online only and logs all voice channels so you can copy an ID. You can also join later with `!join <channelId>` (see below) without restarting.

See `.env.example` for a copy-paste template.

## Self-commands

Send these from your own account (DM or any text channel). Only your own messages trigger them.

- `!join <channelId>` — join a VC and stay there (accepts `<#id>` mentions too)
- `!join` — rejoin the current target VC
- `!leave` — leave VC and pause auto-rejoin until next `!join`
- `!status` — show current VC / target / connection state
- `!vcs` — list all voice channels with IDs
- `!purple` / `!purple off` / `!purple on` — is the purple streaming dot on, switch it
- `!live` / `!live off` / `!live on` — is the LIVE badge showing, remove it, ask for it again
- `!timer` — time in VC for this stay and in total
- `!reload` — read the cards' applications again (new pictures) and send the cards again
- `!day` / `!day 5` / `!day reset` — show the day counter, make today day 5, or go back to `DAY_ONE`
- `!countdown 31-12-2026 23:59` / `!countdown` / `!countdown off` — make the card's clock count down, show it, or stop it
- `!activity <text>` — change the custom status text (kept across restarts)
- `!activity off` / `!activity on` / `!activity reset` — hide it, show it, or restore the default text
- `!help` — show help

## Troubleshooting

- `npm: command not found` on Railway — Railway didn't install Node. This repo now includes `railway.toml` (Nixpacks builder, `npm ci` build, `npm start` start) plus a `Dockerfile` (`node:20-alpine`) as fallback. Push/redeploy so Railway picks them up. In Railway → Settings → Build, make sure Builder is **Nixpacks** (or **Docker** with the included Dockerfile) and Start Command is `npm start`. Check **Deployments → Logs**, not Console.
- Logs stop at `Connecting to Discord...` — wait a minute; the next lines now say why. `Discord rejected the token` means the `token` variable is wrong or expired (changing your password or logging out resets it): copy a fresh one, no quotes or spaces. `Could not get the gateway address` / repeated `Gateway error` lines mean the host can't reach Discord; it keeps retrying on its own.
- `Not logged in yet (shard 0: ready)` — old version: the library waited for a server-sync reply Discord no longer sends. Fixed in `eris_user_patch.js`; redeploy the latest `main`.
- Status line shows but the card doesn't — look in the logs for `👁️ Discord reports this account as`. If the card is listed there, Discord has it and the account's privacy setting is hiding it: on that account open Settings > Activity Privacy and turn on "Share your detected activities with others" (also check the same switch in the server's privacy settings). If the logs say `dropped the card`, the `APPLICATION_ID` is wrong.
- `Voice channel ... not found` — the account isn't in that server, or the ID is wrong (it must be the channel ID, not the server ID). Run `!vcs` to list valid IDs.
- `Discord did not confirm joining` — Discord ignored the join: you lack Connect permission, the channel is full, or the ID is wrong. It retries automatically.
- `/health` on the keep-alive URL shows `ready`, the current `vc` and whether it is `inTarget`.
- Bot goes offline — check the keep-alive URL with UptimeRobot and the host logs. The `keep_alive.js` server listens on `PORT` (default 8080) and answers `I'm alive` at `/`.
