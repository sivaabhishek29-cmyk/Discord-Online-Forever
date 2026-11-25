// Lifetime "time spent in voice" counter, saved to a small JSON file so it
// survives restarts (as long as the file lives on persistent storage).
const fs = require("fs");
const path = require("path");

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(totalMinutes / 1440);
  const h = Math.floor((totalMinutes % 1440) / 60);
  const m = totalMinutes % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function createVcTimer({ file, now = Date.now, onError = () => {} }) {
  let data = { totalMs: 0 };
  let loaded = false; // true when an earlier total was found on disk
  let since = null; // start of the current stay, or null when not in voice

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") {
      data = parsed;
      if (!Number.isFinite(data.totalMs) || data.totalMs < 0) data.totalMs = 0;
      loaded = true;
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      // Unreadable/corrupt file: keep a copy instead of silently overwriting it.
      try {
        fs.renameSync(file, `${file}.bad`);
      } catch {
        // ignore
      }
      onError(err);
    }
  }

  function stayMs() {
    return since === null ? 0 : Math.max(0, now() - since);
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const snapshot = { ...data, totalMs: data.totalMs + stayMs(), savedAt: new Date(now()).toISOString() };
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot));
      fs.renameSync(tmp, file); // atomic: never leaves a half-written file
      return true;
    } catch (err) {
      onError(err);
      return false;
    }
  }

  return {
    loaded,
    file,
    start() {
      if (since === null) since = now();
    },
    stop() {
      if (since === null) return;
      data.totalMs += stayMs();
      since = null;
      save();
    },
    running: () => since !== null,
    stayStart: () => since,
    stayMs,
    totalMs: () => data.totalMs + stayMs(),
    // Small extra settings stored next to the total (e.g. the custom status text).
    get: (key) => data[key],
    set(key, value) {
      if (value === undefined || value === null) delete data[key];
      else data[key] = value;
      save();
    },
    save,
  };
}

module.exports = { createVcTimer, formatDuration };
