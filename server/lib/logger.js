import util from 'util';

// Ring buffer for live server logs (500 lines)
export const MAX_LIVE_LOGS = 500;
export const MAX_EVENTS = 50;

let logSequence = 0;
const liveLogs = [];
const eventLog = [];

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  return text
    // Gemini API keys
    .replace(/AIzaSy[A-Za-z0-9_-]{33}/g, 'AIzaSy***[REDACTED]')
    // Groq API keys
    .replace(/gsk_[A-Za-z0-9]{20,}/g, 'gsk_***[REDACTED]')
    // Bearer tokens
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***[REDACTED]')
    // Redis connection URLs with credentials
    .replace(/:\/\/(:[^@]+)@/g, '://:***@')
    // Dashboard passwords
    .replace(/(?:password|pass|token)["']?\s*[:=]\s*["']?([^"',\s}]+)/gi, (match, p1) => {
      if (p1 && p1.length > 3) return match.replace(p1, '***');
      return match;
    });
}

function pushLogLine(level, rawText) {
  const clean = redactSecrets(String(rawText || '').trim());
  if (!clean) return;

  const entry = {
    id: ++logSequence,
    timestamp: Date.now(),
    level, // 'info' | 'warn' | 'error'
    text: clean
  };

  liveLogs.push(entry);
  if (liveLogs.length > MAX_LIVE_LOGS) {
    liveLogs.shift();
  }
}

// Intercept stdout
process.stdout.write = function (chunk, encoding, callback) {
  try {
    const str = typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8');
    const lines = str.split('\n');
    for (const l of lines) {
      if (l.trim()) {
        const lvl = /\[warn\]/i.test(l) ? 'warn' : (/\[error\]/i.test(l) ? 'error' : 'info');
        pushLogLine(lvl, l);
      }
    }
  } catch (_) {}
  return originalStdoutWrite(chunk, encoding, callback);
};

// Intercept stderr
process.stderr.write = function (chunk, encoding, callback) {
  try {
    const str = typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8');
    const lines = str.split('\n');
    for (const l of lines) {
      if (l.trim()) pushLogLine('error', l);
    }
  } catch (_) {}
  return originalStderrWrite(chunk, encoding, callback);
};

// Global unhandled error capturing
process.on('uncaughtException', (err) => {
  pushLogLine('error', `Uncaught Exception: ${err?.stack || err?.message || err}`);
});

process.on('unhandledRejection', (reason) => {
  pushLogLine('error', `Unhandled Rejection: ${reason?.stack || reason?.message || reason}`);
});

export function logEvent(level, message) {
  const item = { time: Date.now(), level, message: redactSecrets(message) };
  eventLog.push(item);
  if (eventLog.length > MAX_EVENTS) {
    eventLog.shift();
  }
  const prefix = (level || 'info').toUpperCase().padEnd(5);
  console.log(`[${prefix}] ${message}`);
}

export function getEventLog() {
  return eventLog.slice();
}

export function getLiveLogs(afterId = 0, limit = 200, levelFilter = 'all') {
  let list = liveLogs;
  if (afterId > 0) {
    list = list.filter(l => l.id > afterId);
  }
  if (levelFilter && levelFilter !== 'all') {
    list = list.filter(l => l.level === levelFilter);
  }
  if (limit > 0 && list.length > limit) {
    list = list.slice(-limit);
  }
  return list;
}
