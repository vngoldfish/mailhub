// ─── Logger Module ───────────────────────────────────────────────
// Structured logging with timestamps and levels

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = LEVELS[process.env.LOG_LEVEL || "info"] ?? 1;

// In-memory log buffer for UI (keep last 500 entries)
const LOG_BUFFER_MAX = 500;
const logBuffer = [];

function formatTime() {
  return new Date().toISOString();
}

function addToBuffer(entry) {
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
}

export function getLogBuffer() {
  return logBuffer;
}

export function clearLogBuffer() {
  logBuffer.length = 0;
}

export function log(level, tag, message, extra = {}) {
  if (LEVELS[level] == null || LEVELS[level] < LOG_LEVEL) return;

  const entry = {
    time: formatTime(),
    level,
    tag,
    message,
    ...extra
  };

  addToBuffer(entry);

  const prefix = `${entry.time} [${level.toUpperCase()}] [${tag}]`;
  const extraStr = Object.keys(extra).length
    ? " " + JSON.stringify(extra)
    : "";

  switch (level) {
    case "error":
      console.error(`${prefix} ${message}${extraStr}`);
      break;
    case "warn":
      console.warn(`${prefix} ${message}${extraStr}`);
      break;
    case "debug":
      console.debug(`${prefix} ${message}${extraStr}`);
      break;
    default:
      console.log(`${prefix} ${message}${extraStr}`);
  }

  return entry;
}
