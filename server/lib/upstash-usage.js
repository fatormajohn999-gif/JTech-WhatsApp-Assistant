import { redis } from './redis.js';
import { logEvent } from './logger.js';

let cachedUsage = null;
let lastUsageFetch = 0;
const USAGE_CACHE_TTL = 3 * 60 * 1000; // 3 minutes

export const DEFAULT_USAGE_LIMITS = {
  maxMonthlyCommands: 500000,
  maxBandwidthBytes: 10 * 1024 * 1024 * 1024, // 10 GB
  maxStorageBytes: 250 * 1024 * 1024 // 250 MB
};

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export async function getUpstashCredentials() {
  const [email, apiKey, dbId, limitsRaw] = await Promise.all([
    redis.get('config:upstash:email'),
    redis.get('config:upstash:api_key'),
    redis.get('config:upstash:db_id'),
    redis.get('config:upstash:limits')
  ]);

  let limits = { ...DEFAULT_USAGE_LIMITS };
  if (limitsRaw) {
    try {
      const parsed = JSON.parse(limitsRaw);
      limits = { ...limits, ...parsed };
    } catch (_) {}
  }

  return {
    email: (email || '').trim(),
    apiKey: (apiKey || '').trim(),
    dbId: (dbId || '').trim(),
    limits
  };
}

export async function getRedisUsage(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedUsage && (now - lastUsageFetch < USAGE_CACHE_TTL)) {
    return cachedUsage;
  }

  const { email, apiKey, dbId, limits } = await getUpstashCredentials();
  const maxCommands = limits.maxMonthlyCommands || 500000;
  const maxBandwidth = limits.maxBandwidthBytes || (10 * 1024 * 1024 * 1024);
  const maxStorage = limits.maxStorageBytes || (250 * 1024 * 1024);

  // Attempt Upstash Management API v2
  if (email && apiKey && dbId) {
    try {
      const authHeader = 'Basic ' + Buffer.from(`${email}:${apiKey}`).toString('base64');
      const [dbRes, statsRes] = await Promise.allSettled([
        fetch(`https://api.upstash.com/v2/redis/database/${dbId}`, {
          headers: { Authorization: authHeader }
        }),
        fetch(`https://api.upstash.com/v2/redis/database/${dbId}/stats`, {
          headers: { Authorization: authHeader }
        })
      ]);

      if (dbRes.status === 'fulfilled' && dbRes.value.ok) {
        const dbData = await dbRes.value.json();
        let statsData = {};
        if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
          try { statsData = await statsRes.value.json(); } catch (_) {}
        }

        // Upstash API fields
        const totalCommands = statsData.total_commands || statsData.commands_count || dbData.commands_count || 0;
        const totalBandwidth = statsData.total_bandwidth || statsData.bandwidth || 0;
        const storageBytes = dbData.memory_size || statsData.memory_usage || (dbData.key_count ? dbData.key_count * 512 : 0);

        const daysInMonth = new Date().getUTCDate();
        const estimatedDaily = Math.round(totalCommands / Math.max(1, daysInMonth));

        const cmdPercent = Math.min(100, Math.round((totalCommands / maxCommands) * 100));
        const bwPercent = Math.min(100, Math.round((totalBandwidth / maxBandwidth) * 100));
        const storagePercent = Math.min(100, Math.round((storageBytes / maxStorage) * 100));

        cachedUsage = {
          source: 'upstash_api',
          sourceLabel: 'Upstash API',
          configured: true,
          databaseId: dbId,
          databaseName: dbData.database_name || 'Upstash Redis',
          commands: {
            used: totalCommands,
            limit: maxCommands,
            percent: cmdPercent,
            reads: statsData.read_commands || null,
            writes: statsData.write_commands || null,
            estimatedDaily
          },
          bandwidth: {
            usedBytes: totalBandwidth,
            usedFormatted: formatBytes(totalBandwidth),
            limitBytes: maxBandwidth,
            limitFormatted: formatBytes(maxBandwidth),
            percent: bwPercent
          },
          storage: {
            usedBytes: storageBytes,
            usedFormatted: formatBytes(storageBytes),
            limitBytes: maxStorage,
            limitFormatted: formatBytes(maxStorage),
            percent: storagePercent
          },
          cost: {
            amount: totalCommands > maxCommands ? `$${(((totalCommands - maxCommands) / 100000) * 0.2).toFixed(2)}` : '$0.00',
            tier: dbData.tier || 'Free Tier'
          },
          updatedAt: Date.now()
        };
        lastUsageFetch = now;
        return cachedUsage;
      }
    } catch (apiErr) {
      console.warn('[UpstashUsage] Upstash API fetch failed, falling back to app estimates:', apiErr.message);
    }
  }

  // Graceful Fallback: In-app Redis command estimation
  const appEst = redis.getAppEstimatedUsage();
  let dbsizeCount = 0;
  try {
    dbsizeCount = await redis.dbsize();
  } catch (_) {
    dbsizeCount = appEst.keyCount || 0;
  }

  const estimatedStorageBytes = dbsizeCount * 1024; // Approx 1KB per key on average
  const totalCmds = appEst.totalCommands;
  const cmdPercent = Math.min(100, Math.round((totalCmds / maxCommands) * 100));
  const bwPercent = Math.min(100, Math.round((appEst.totalBytes / maxBandwidth) * 100));
  const storagePercent = Math.min(100, Math.round((estimatedStorageBytes / maxStorage) * 100));

  cachedUsage = {
    source: 'estimated',
    sourceLabel: 'Estimated by this app',
    configured: Boolean(email && apiKey && dbId),
    databaseId: dbId || 'Default Instance',
    databaseName: 'Upstash Redis',
    commands: {
      used: totalCmds,
      limit: maxCommands,
      percent: cmdPercent,
      reads: appEst.reads,
      writes: appEst.writes,
      estimatedDaily: appEst.estimatedDailyCommands
    },
    bandwidth: {
      usedBytes: appEst.totalBytes,
      usedFormatted: formatBytes(appEst.totalBytes),
      limitBytes: maxBandwidth,
      limitFormatted: formatBytes(maxBandwidth),
      percent: bwPercent
    },
    storage: {
      usedBytes: estimatedStorageBytes,
      usedFormatted: formatBytes(estimatedStorageBytes),
      limitBytes: maxStorage,
      limitFormatted: formatBytes(maxStorage),
      percent: storagePercent
    },
    cost: {
      amount: '$0.00',
      tier: 'Free Tier'
    },
    updatedAt: Date.now()
  };
  lastUsageFetch = now;
  return cachedUsage;
}

export function invalidateUsageCache() {
  cachedUsage = null;
  lastUsageFetch = 0;
}
