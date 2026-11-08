import express from 'express';
import { requireAuth } from './auth.js';
import { redis } from '../lib/redis.js';
import {
  getPendingTeachMe,
  answerTeachMeItem,
  dismissTeachMeItem,
  listKnowledge,
  addKnowledgeItem,
  updateKnowledgeItem,
  deleteKnowledgeItem
} from '../memory/knowledge.js';
import {
  getLearnedStyle,
  getLearnedExamples,
  deleteLearnedExample,
  clearAllLearnedData,
  resetLearnedStyle
} from '../memory/owner-style.js';
import { sendDailySummary } from '../lib/daily-summary.js';

const router = express.Router();

// 1. Teach-Me Inbox
router.get('/teachme', requireAuth, async (req, res) => {
  try {
    const items = await getPendingTeachMe();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/teachme/:id/answer', requireAuth, async (req, res) => {
  try {
    const { answer, scope, sendToContact } = req.body;
    const result = await answerTeachMeItem(req.params.id, {
      answer,
      scope,
      sendToContact: Boolean(sendToContact)
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/teachme/:id', requireAuth, async (req, res) => {
  try {
    const success = await dismissTeachMeItem(req.params.id);
    res.json({ success });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/teachme/:id/dismiss', requireAuth, async (req, res) => {
  try {
    const success = await dismissTeachMeItem(req.params.id);
    res.json({ success });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Knowledge Base CRUD
router.get('/knowledge', requireAuth, async (req, res) => {
  try {
    const items = await listKnowledge();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/knowledge', requireAuth, async (req, res) => {
  try {
    const { question, answer, scope, contactJid } = req.body;
    const item = await addKnowledgeItem({ question, answer, scope, contactJid });
    res.json({ success: true, item });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/knowledge/:id', requireAuth, async (req, res) => {
  try {
    const item = await updateKnowledgeItem(req.params.id, req.body);
    res.json({ success: true, item });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/knowledge/:id', requireAuth, async (req, res) => {
  try {
    const success = await deleteKnowledgeItem(req.params.id);
    res.json({ success });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Learned Style
router.get('/style', requireAuth, async (req, res) => {
  try {
    const jid = req.query.jid || '';
    const style = await getLearnedStyle(jid);
    res.json(style);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/style/reset', requireAuth, async (req, res) => {
  try {
    await resetLearnedStyle();
    res.json({ success: true, message: 'Learned style reset' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Learned Examples for Contact
router.get('/owner-examples/:jid', requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '10', 10);
    const examples = await getLearnedExamples(req.params.jid, limit);
    res.json({ examples });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/owner-examples/:jid/:id', requireAuth, async (req, res) => {
  try {
    await deleteLearnedExample(req.params.jid, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Clear all learned data
router.post('/clear-learned-data', requireAuth, async (req, res) => {
  try {
    await clearAllLearnedData();
    res.json({ success: true, message: 'All learned reply data and style descriptions cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Daily Summary
router.get('/summary/latest', requireAuth, async (req, res) => {
  try {
    const raw = await redis.get('summary:latest');
    const summary = raw ? JSON.parse(raw) : null;
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/summary/trigger-now', requireAuth, async (req, res) => {
  try {
    const result = await sendDailySummary(null, true);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
