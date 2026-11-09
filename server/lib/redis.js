import { Redis } from '@upstash/redis';
import { UPSTASH_URL, UPSTASH_TOKEN } from '../config.js';
import { logEvent } from './logger.js';

function getCurrentMonthKey() {
  const d = new Date();
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export class UpstashStore {
  constructor() {
    this.isUpstash = Boolean(UPSTASH_URL && UPSTASH_TOKEN && !UPSTASH_URL.includes('your-database'));
    if (this.isUpstash) {
      try {
        this.client = new Redis({
          url: UPSTASH_URL,
          token: UPSTASH_TOKEN,
          automaticDeserialization: false
        });
        logEvent('info', 'Connected to Upstash Redis REST (automaticDeserialization: false)');
      } catch (err) {
        logEvent('error', `Upstash init error, falling back to local memory store: ${err.message}`);
        this.client = null;
        this.isUpstash = false;
      }
    } else {
      logEvent('warn', 'No valid UPSTASH_REDIS_REST_URL / TOKEN. Running with in-memory store.');
      this.client = null;
    }

    this.memory = new Map();
    this.hashes = new Map();
    this.sets = new Map();

    // Command usage tracking (in memory, periodically flushed to Redis)
    this.usage = {
      reads: 0,
      writes: 0,
      bytesRead: 0,
      bytesWritten: 0,
      flushedReads: 0,
      flushedWrites: 0,
      flushedBytesRead: 0,
      flushedBytesWritten: 0,
      lastFlushedAt: Date.now()
    };

    // Load persisted month counts from Redis on startup
    this.initMonthUsage().catch(() => {});

    // Periodic flush every 5 minutes (single Redis write per 5 mins)
    this.flushInterval = setInterval(() => {
      this.flushUsageStats().catch(() => {});
    }, 5 * 60 * 1000);
  }

  async initMonthUsage() {
    try {
      const monthKey = getCurrentMonthKey();
      const raw = await this.get(`stats:redis:usage:${monthKey}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.usage.reads = parsed.reads || 0;
        this.usage.writes = parsed.writes || 0;
        this.usage.bytesRead = parsed.bytesRead || 0;
        this.usage.bytesWritten = parsed.bytesWritten || 0;
        this.usage.flushedReads = this.usage.reads;
        this.usage.flushedWrites = this.usage.writes;
        this.usage.flushedBytesRead = this.usage.bytesRead;
        this.usage.flushedBytesWritten = this.usage.bytesWritten;
      }
    } catch (_) {}
  }

  recordRead(approxBytes = 64) {
    this.usage.reads += 1;
    this.usage.bytesRead += approxBytes;
  }

  recordWrite(approxBytes = 64) {
    this.usage.writes += 1;
    this.usage.bytesWritten += approxBytes;
  }

  async flushUsageStats() {
    const unflushedReads = this.usage.reads - this.usage.flushedReads;
    const unflushedWrites = this.usage.writes - this.usage.flushedWrites;

    // Skip if no commands were issued since last flush
    if (unflushedReads === 0 && unflushedWrites === 0) return;

    try {
      const monthKey = getCurrentMonthKey();
      const payload = {
        month: monthKey,
        reads: this.usage.reads,
        writes: this.usage.writes,
        total: this.usage.reads + this.usage.writes,
        bytesRead: this.usage.bytesRead,
        bytesWritten: this.usage.bytesWritten,
        totalBytes: this.usage.bytesRead + this.usage.bytesWritten,
        updatedAt: Date.now()
      };

      // Write directly without calling wrapper set() to avoid recursion loop
      const strVal = JSON.stringify(payload);
      if (this.isUpstash && this.client) {
        await this.client.set(`stats:redis:usage:${monthKey}`, strVal);
      } else {
        this.memory.set(`stats:redis:usage:${monthKey}`, strVal);
      }

      this.usage.flushedReads = this.usage.reads;
      this.usage.flushedWrites = this.usage.writes;
      this.usage.flushedBytesRead = this.usage.bytesRead;
      this.usage.flushedBytesWritten = this.usage.bytesWritten;
      this.usage.lastFlushedAt = Date.now();
    } catch (e) {
      console.warn('[Redis] Flush usage stats error:', e.message);
    }
  }

  getAppEstimatedUsage() {
    const totalCommands = this.usage.reads + this.usage.writes;
    const totalBytes = this.usage.bytesRead + this.usage.bytesWritten;
    const now = new Date();
    const dayOfMonth = now.getUTCDate();
    const estimatedDailyCommands = Math.round(totalCommands / Math.max(1, dayOfMonth));

    // Approximate key count
    const keyCount = this.memory.size + this.hashes.size + this.sets.size;

    return {
      reads: this.usage.reads,
      writes: this.usage.writes,
      totalCommands,
      bytesRead: this.usage.bytesRead,
      bytesWritten: this.usage.bytesWritten,
      totalBytes,
      keyCount,
      estimatedDailyCommands,
      lastFlushedAt: this.usage.lastFlushedAt
    };
  }

  async ping() {
    this.recordRead(16);
    try {
      if (this.isUpstash && this.client) {
        await this.client.get('__ping__');
        return 'ok';
      }
      return this.isUpstash ? 'error' : 'ok';
    } catch (_) {
      return 'error';
    }
  }

  async dbsize() {
    this.recordRead(16);
    try {
      if (this.isUpstash && this.client) {
        const res = await this.client.dbsize();
        if (typeof res === 'number') return res;
      }
    } catch (_) {}
    return this.memory.size + this.hashes.size + this.sets.size;
  }

  async get(key) {
    this.recordRead(key.length + 32);
    try {
      if (this.isUpstash && this.client) {
        const val = await this.client.get(key);
        const strVal = val === null ? null : String(val);
        if (strVal) this.usage.bytesRead += strVal.length;
        return strVal;
      }
    } catch (e) {
      console.error(`[Redis] GET error for ${key}:`, e.message);
    }
    return this.memory.has(key) ? this.memory.get(key) : null;
  }

  async mget(...keys) {
    keys = keys.flat().filter(Boolean);
    if (keys.length === 0) return [];
    this.recordRead(keys.join('').length + 32);
    try {
      if (this.isUpstash && this.client) {
        const res = await this.client.mget(...keys);
        if (Array.isArray(res)) {
          return res.map(v => {
            if (v === null || v === undefined) return null;
            const str = String(v);
            this.usage.bytesRead += str.length;
            return str;
          });
        }
      }
    } catch (e) {
      console.error(`[Redis] MGET error for ${keys.length} keys:`, e.message);
    }
    return keys.map(k => this.memory.has(k) ? this.memory.get(k) : null);
  }

  async set(key, value, options = {}) {
    const strVal = typeof value === 'string' ? value : JSON.stringify(value);
    this.recordWrite(key.length + strVal.length + 32);
    try {
      if (this.isUpstash && this.client) {
        if (options.ex) {
          await this.client.set(key, strVal, { ex: options.ex });
        } else {
          await this.client.set(key, strVal);
        }
        return 'OK';
      }
      this.memory.set(key, strVal);
      return 'OK';
    } catch (e) {
      console.error(`[Redis] SET error for ${key}:`, e.message);
      this.memory.set(key, String(value));
      return 'OK';
    }
  }

  async del(...keys) {
    keys = keys.flat().filter(Boolean);
    if (keys.length === 0) return 0;
    this.recordWrite(keys.join('').length + 32);
    try {
      if (this.isUpstash && this.client) {
        await this.client.del(...keys);
      }
    } catch (e) {
      console.error(`[Redis] DEL error for ${keys.length} key(s):`, e.message);
    }
    for (const key of keys) {
      this.memory.delete(key);
      this.hashes.delete(key);
      this.sets.delete(key);
    }
    return keys.length;
  }

  async expire(key, seconds) {
    this.recordWrite(key.length + 16);
    try {
      if (this.isUpstash && this.client) {
        return await this.client.expire(key, seconds);
      }
    } catch (e) {
      console.error(`[Redis] EXPIRE error for ${key}:`, e.message);
    }
    return 1;
  }

  async incr(key) {
    this.recordWrite(key.length + 16);
    try {
      if (this.isUpstash && this.client) {
        return await this.client.incr(key);
      }
    } catch (e) {
      console.error(`[Redis] INCR error for ${key}:`, e.message);
    }
    const current = parseInt(this.memory.get(key) || '0', 10);
    const next = current + 1;
    this.memory.set(key, String(next));
    return next;
  }

  async lpush(key, value) {
    const strVal = typeof value === 'string' ? value : JSON.stringify(value);
    this.recordWrite(key.length + strVal.length + 32);
    try {
      if (this.isUpstash && this.client) {
        return await this.client.lpush(key, strVal);
      }
    } catch (e) {
      console.error(`[Redis] LPUSH error for ${key}:`, e.message);
    }
    const list = this.getMemoryList(key);
    list.unshift(strVal);
    this.memory.set(key, JSON.stringify(list));
    return list.length;
  }

  async rpush(key, value) {
    const strVal = typeof value === 'string' ? value : JSON.stringify(value);
    this.recordWrite(key.length + strVal.length + 32);
    try {
      if (this.isUpstash && this.client) {
        return await this.client.rpush(key, strVal);
      }
    } catch (e) {
      console.error(`[Redis] RPUSH error for ${key}:`, e.message);
    }
    const list = this.getMemoryList(key);
    list.push(strVal);
    this.memory.set(key, JSON.stringify(list));
    return list.length;
  }

  async lrange(key, start, stop) {
    this.recordRead(key.length + 32);
    try {
      if (this.isUpstash && this.client) {
        const res = await this.client.lrange(key, start, stop);
        if (Array.isArray(res)) return res.map(String);
      }
    } catch (e) {
      console.error(`[Redis] LRANGE error for ${key}:`, e.message);
    }
    const list = this.getMemoryList(key);
    const len = list.length;
    let s = start < 0 ? Math.max(0, len + start) : start;
    let e = stop < 0 ? Math.max(0, len + stop) : stop;
    return list.slice(s, e + 1);
  }

  async ltrim(key, start, stop) {
    this.recordWrite(key.length + 32);
    try {
      if (this.isUpstash && this.client) {
        return await this.client.ltrim(key, start, stop);
      }
    } catch (e) {
      console.error(`[Redis] LTRIM error for ${key}:`, e.message);
    }
    const list = this.getMemoryList(key);
    const len = list.length;
    let s = start < 0 ? Math.max(0, len + start) : start;
    let e = stop < 0 ? Math.max(0, len + stop) : stop;
    const trimmed = list.slice(s, e + 1);
    this.memory.set(key, JSON.stringify(trimmed));
    return 'OK';
  }

  // ---------- Hashes ----------
  async hset(key, fieldOrObject, value) {
    const obj = (fieldOrObject && typeof fieldOrObject === 'object')
      ? fieldOrObject
      : { [fieldOrObject]: value };
    const data = {};
    let approxBytes = key.length;
    for (const [f, v] of Object.entries(obj)) {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      data[f] = s;
      approxBytes += f.length + s.length;
    }
    this.recordWrite(approxBytes + 32);
    try {
      if (this.isUpstash && this.client) {
        await this.client.hset(key, data);
        return Object.keys(data).length;
      }
    } catch (e) {
      console.error(`[Redis] HSET error for ${key}:`, e.message);
    }
    const h = this.hashes.get(key) || new Map();
    for (const [f, v] of Object.entries(data)) h.set(f, v);
    this.hashes.set(key, h);
    return Object.keys(data).length;
  }

  async hget(key, field) {
    this.recordRead(key.length + field.length + 32);
    try {
      if (this.isUpstash && this.client) {
        const val = await this.client.hget(key, field);
        return val === null || val === undefined ? null : (typeof val === 'string' ? val : JSON.stringify(val));
      }
    } catch (e) {
      console.error(`[Redis] HGET error for ${key}:`, e.message);
    }
    const h = this.hashes.get(key);
    return h && h.has(field) ? h.get(field) : null;
  }

  async hgetall(key) {
    this.recordRead(key.length + 64);
    try {
      if (this.isUpstash && this.client) {
        const res = await this.client.hgetall(key);
        if (!res || Object.keys(res).length === 0) return null;
        const out = {};
        for (const [f, v] of Object.entries(res)) {
          out[f] = typeof v === 'string' ? v : JSON.stringify(v);
        }
        return out;
      }
    } catch (e) {
      console.error(`[Redis] HGETALL error for ${key}:`, e.message);
    }
    const h = this.hashes.get(key);
    if (!h || h.size === 0) return null;
    return Object.fromEntries(h);
  }

  async hdel(key, ...fields) {
    fields = fields.flat().filter(f => f !== undefined && f !== null);
    if (fields.length === 0) return 0;
    this.recordWrite(key.length + fields.join('').length + 32);
    try {
      if (this.isUpstash && this.client) {
        return await this.client.hdel(key, ...fields);
      }
    } catch (e) {
      console.error(`[Redis] HDEL error for ${key}:`, e.message);
    }
    const h = this.hashes.get(key);
    if (!h) return 0;
    let removed = 0;
    for (const f of fields) if (h.delete(f)) removed++;
    if (h.size === 0) this.hashes.delete(key);
    return removed;
  }

  // ---------- Sets ----------
  async sadd(key, ...members) {
    members = members.flat().filter(m => m !== undefined && m !== null).map(String);
    if (members.length === 0) return 0;
    this.recordWrite(key.length + members.join('').length + 32);
    try {
      if (this.isUpstash && this.client) {
        return await this.client.sadd(key, members[0], ...members.slice(1));
      }
    } catch (e) {
      console.error(`[Redis] SADD error for ${key}:`, e.message);
    }
    const set = this.sets.get(key) || new Set();
    let added = 0;
    for (const m of members) if (!set.has(m)) { set.add(m); added++; }
    this.sets.set(key, set);
    return added;
  }

  async srem(key, ...members) {
    members = members.flat().filter(m => m !== undefined && m !== null).map(String);
    if (members.length === 0) return 0;
    this.recordWrite(key.length + members.join('').length + 32);
    try {
      if (this.isUpstash && this.client) {
        return await this.client.srem(key, ...members);
      }
    } catch (e) {
      console.error(`[Redis] SREM error for ${key}:`, e.message);
    }
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) if (set.delete(m)) removed++;
    if (set.size === 0) this.sets.delete(key);
    return removed;
  }

  async smembers(key) {
    this.recordRead(key.length + 32);
    try {
      if (this.isUpstash && this.client) {
        const res = await this.client.smembers(key);
        return Array.isArray(res) ? res.map(String) : [];
      }
    } catch (e) {
      console.error(`[Redis] SMEMBERS error for ${key}:`, e.message);
    }
    const set = this.sets.get(key);
    return set ? Array.from(set) : [];
  }

  // ---------- Key search ----------
  async keys(pattern = '*') {
    this.recordRead(pattern.length + 64);
    try {
      if (this.isUpstash && this.client) {
        const res = await this.client.keys(pattern);
        return Array.isArray(res) ? res.map(String) : [];
      }
    } catch (e) {
      console.error(`[Redis] KEYS error for ${pattern}:`, e.message);
    }
    return this.matchMemoryKeys(pattern);
  }

  async scan(cursor = '0', options = {}) {
    this.recordRead(64);
    try {
      if (this.isUpstash && this.client) {
        const res = await this.client.scan(cursor, options);
        const next = String(res[0]);
        const found = Array.isArray(res[1]) ? res[1].map(String) : [];
        return [next, found];
      }
    } catch (e) {
      console.error(`[Redis] SCAN error:`, e.message);
      return ['0', []];
    }
    return ['0', this.matchMemoryKeys(options.match || '*')];
  }

  matchMemoryKeys(pattern) {
    const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    const re = new RegExp('^' + escaped + '$');
    const all = new Set([...this.memory.keys(), ...this.hashes.keys(), ...this.sets.keys()]);
    return Array.from(all).filter(k => re.test(k));
  }

  getMemoryList(key) {
    try {
      const raw = this.memory.get(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_) {}
    return [];
  }
}

export const redis = new UpstashStore();
