import express from 'express';
import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { getChatMemory, jidToPhone } from '../memory/store.js';
import { requireAuth } from './auth.js';

const router = express.Router();

router.get('/chats', requireAuth, async (req, res) => {
  try {
    const recentRaw = await redis.get('chats:recent');
    let jids = [];
    if (recentRaw) {
      try { jids = JSON.parse(recentRaw); } catch (_) {}
    }

    const conversations = [];
    for (const jid of jids.slice(0, 30)) {
      try {
        const [metaRaw, handoffVal] = await Promise.all([
          redis.get(`chat:${jid}:meta`),
          redis.get(`handoff:${jid}`)
        ]);

        let isHandoff = false;
        if (handoffVal) {
          const until = parseInt(handoffVal, 10);
          isHandoff = isNaN(until) ? true : Date.now() < until;
        }

        if (metaRaw) {
          const meta = JSON.parse(metaRaw);
          meta.isHandoff = isHandoff;
          conversations.push(meta);
        } else {
          conversations.push({
            jid,
            name: jidToPhone(jid) || jid,
            lastMessage: '',
            timestamp: 0,
            isHandoff
          });
        }
      } catch (_) {}
    }

    res.json({ conversations });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'CHATS_FETCH_FAILED',
      hint: 'Failed to retrieve active chat list.'
    });
  }
});

router.get('/chats/:jid', requireAuth, async (req, res) => {
  try {
    const { jid } = req.params;
    const memory = await getChatMemory(jid);
    const metaRaw = await redis.get(`chat:${jid}:meta`);
    let meta = null;
    if (metaRaw) {
      try { meta = JSON.parse(metaRaw); } catch (_) {}
    }

    res.json({
      jid,
      meta,
      isHandoff: memory.isHandoff,
      summary: memory.summary,
      facts: memory.facts,
      profile: memory.profile,
      messages: memory.messages.slice(-12)
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'CHAT_DETAIL_FAILED',
      hint: 'Failed to retrieve conversation details.'
    });
  }
});

router.post('/chats/:jid/takeover', requireAuth, async (req, res) => {
  try {
    const { jid } = req.params;
    await redis.set(`handoff:${jid}`, 'manual_takeover');
    logEvent('info', `Human takeover activated for ${jid}`);
    res.json({ success: true, message: `Bot paused for ${jid}. Human takeover active.` });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'TAKEOVER_FAILED',
      hint: 'Unable to update handoff status in Redis.'
    });
  }
});

router.post('/chats/:jid/resume', requireAuth, async (req, res) => {
  try {
    const { jid } = req.params;
    await redis.del(`handoff:${jid}`);
    logEvent('info', `Bot resumed for ${jid}`);
    res.json({ success: true, message: `Bot resumed for ${jid}.` });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'RESUME_FAILED',
      hint: 'Unable to remove handoff status in Redis.'
    });
  }
});

export default router;
