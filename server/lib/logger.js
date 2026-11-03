// Ring buffer for in-app event log
export const MAX_EVENTS = 20;
const eventLog = [];

export function logEvent(level, message) {
  const item = { time: Date.now(), level, message };
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
