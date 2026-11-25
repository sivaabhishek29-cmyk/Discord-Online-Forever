// A small virtual pet that lives on the account's status line. It gets hungry
// and bored as time passes, sleeps at night, and anyone can DM the account
// "feed", "play", "pat" or "stats" to look after it.
const STEP_MS = 10 * 60 * 1000; // time is replayed in 10-minute steps
const MAX_CATCH_UP_MS = 30 * 24 * 60 * 60 * 1000;
const clampPct = (n) => Math.max(0, Math.min(100, n));
const pct = (n) => `${Math.round(n)}%`;

// "23-7" → { from: 23, to: 7 }. Equal hours (or nonsense) = never sleeps.
function parseSleep(text) {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(String(text || ""));
  if (!m || +m[1] > 23 || +m[2] > 23) return { from: 23, to: 7 };
  return { from: +m[1], to: +m[2] };
}

function hourReader(timeZone) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone });
  } catch {
    fmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "UTC" });
  }
  return (ms) => parseInt(fmt.format(new Date(ms)), 10) % 24;
}

function createPet({
  load = () => null,
  save = () => {},
  now = Date.now,
  name = "Mochi",
  emoji = "", // fixed face; empty = cat faces that follow the mood
  hungerHours = 12, // full → empty while awake
  boredHours = 8,
  sleep = "23-7",
  timeZone = "Asia/Kolkata",
} = {}) {
  const hours = parseSleep(sleep);
  const hourAt = hourReader(timeZone);
  const asleepAt = (ms) => {
    if (hours.from === hours.to) return false;
    const h = hourAt(ms);
    return hours.from < hours.to ? h >= hours.from && h < hours.to : h >= hours.from || h < hours.to;
  };

  const saved = load();
  const ok = saved && typeof saved === "object" && Number.isFinite(saved.food) && Number.isFinite(saved.fun);
  const s = ok
    ? saved
    : { food: 60, fun: 60, at: now(), born: now(), fed: 0, played: 0 };
  if (!Number.isFinite(s.at)) s.at = now();
  if (!Number.isFinite(s.born)) s.born = now();
  s.fed = s.fed || 0;
  s.played = s.played || 0;
  if (!ok) save(s);

  const petName = () => String(s.name || name).slice(0, 24);

  // Hunger and boredom grow only while the pet is awake.
  function advance() {
    const end = now();
    let from = Math.max(s.at, end - MAX_CATCH_UP_MS);
    if (end - s.at > MAX_CATCH_UP_MS) s.food = s.fun = 0;
    while (from < end) {
      const dt = Math.min(STEP_MS, end - from);
      if (!asleepAt(from + dt / 2)) {
        s.food = clampPct(s.food - (100 * dt) / (hungerHours * 3600000));
        s.fun = clampPct(s.fun - (100 * dt) / (boredHours * 3600000));
      }
      from += dt;
    }
    s.at = end;
  }

  function mood() {
    advance();
    const n = petName();
    const hearts = Math.round((s.food + s.fun) / 40); // 0..5
    const bar = "♥".repeat(hearts) + "♡".repeat(5 - hearts);
    let key, face, text;
    if (asleepAt(now())) [key, face, text] = ["sleeping", "😴", `${n} is sleeping 💤`];
    else if (s.food < 15) [key, face, text] = ["starving", "🙀", `${n} is starving ${bar} · DM me: feed`];
    else if (s.food < 40) [key, face, text] = ["hungry", "😿", `${n} is hungry ${bar} · DM me: feed`];
    else if (s.fun < 30) [key, face, text] = ["bored", "😾", `${n} is bored ${bar} · DM me: play`];
    else if (s.food > 75 && s.fun > 75) [key, face, text] = ["very happy", "😻", `${n} is very happy ${bar}`];
    else [key, face, text] = ["happy", "😺", `${n} is happy ${bar}`];
    if (emoji && key !== "sleeping") face = emoji;
    return { key, face, text };
  }

  const sleepingReply = () =>
    `Shh… ${petName()} is sleeping 💤 Come back after ${String(hours.to).padStart(2, "0")}:00.`;

  return {
    mood,
    name: petName,
    state: () => {
      advance();
      return { ...s };
    },
    feed() {
      if (mood().key === "sleeping") return sleepingReply();
      if (s.food >= 90) return `${petName()} is full already (food ${pct(s.food)}). Try: play`;
      s.food = clampPct(s.food + 35);
      s.fed += 1;
      save(s);
      return `🍖 Yum! ${petName()}'s food is now ${pct(s.food)}. Thank you!`;
    },
    play() {
      if (mood().key === "sleeping") return sleepingReply();
      if (s.fun >= 90) return `${petName()} has played enough for now (fun ${pct(s.fun)}). Try: feed`;
      s.fun = clampPct(s.fun + 40);
      s.played += 1;
      save(s);
      return `🧶 That was fun! ${petName()}'s fun is now ${pct(s.fun)}.`;
    },
    pat() {
      if (mood().key === "sleeping") return `${petName()} purrs in its sleep 💤`;
      s.fun = clampPct(s.fun + 5);
      save(s);
      return `💗 ${petName()} purrs.`;
    },
    stats() {
      const m = mood();
      const days = Math.floor((now() - s.born) / 86400000);
      return (
        `${m.face} ${petName()} is ${m.key} — food ${pct(s.food)}, fun ${pct(s.fun)}, ` +
        `age ${days} day${days === 1 ? "" : "s"}, fed ${s.fed}×, played ${s.played}×.`
      );
    },
    help() {
      return `I'm a self-run account with a pet called ${petName()}. Send me one word: feed, play, pat or stats.`;
    },
    rename(newName) {
      const clean = String(newName || "").replace(/\s+/g, " ").trim().slice(0, 24);
      if (!clean) return false;
      s.name = clean;
      save(s);
      return true;
    },
  };
}

// One word, nothing else, so ordinary DMs never get an automatic answer.
const WORDS = {
  feed: "feed", food: "feed", play: "play", pat: "pat", pet: "pat",
  stats: "stats", status: "stats", help: "help",
};
function petAction(content) {
  const word = String(content || "").trim().toLowerCase().replace(/^[!./]/, "").replace(/[!.?]+$/, "");
  return Object.prototype.hasOwnProperty.call(WORDS, word) ? WORDS[word] : null;
}

// Keeps automatic replies rare: one per person every `perUserMs`, and at most
// `maxPerMinute` in total. Anything over that is ignored.
function createLimiter({ perUserMs = 2000, maxPerMinute = 12, now = Date.now } = {}) {
  const lastByUser = new Map();
  let recent = [];
  return function allow(userId) {
    const t = now();
    recent = recent.filter((x) => t - x < 60000);
    if (recent.length >= maxPerMinute) return false;
    if (lastByUser.has(userId) && t - lastByUser.get(userId) < perUserMs) return false;
    if (lastByUser.size > 500) lastByUser.clear();
    lastByUser.set(userId, t);
    recent.push(t);
    return true;
  };
}

module.exports = { createPet, petAction, createLimiter, parseSleep };
