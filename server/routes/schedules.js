import express from 'express';
import { requireAuth } from './auth.js';
import {
  createSchedule,
  getSchedule,
  updateSchedule,
  deleteSchedule,
  listAllSchedules,
  listContactSchedules,
  pauseSchedule,
  resumeSchedule,
  previewScheduledMessage,
  approveScheduleSend,
  rejectScheduleSend,
  runScheduleNow,
  getSchedulerSummary
} from '../lib/scheduler.js';
import { redis } from '../lib/redis.js';

const router = express.Router();

// GET /api/schedules - list all schedules, pending approvals, and execution history
router.get('/schedules', requireAuth, async (req, res) => {
  try {
    const [schedules, rawHistory, summary] = await Promise.all([
      listAllSchedules(),
      redis.lrange('schedules:history', 0, 49),
      getSchedulerSummary()
    ]);

    const history = (rawHistory || []).map(h => {
      try { return JSON.parse(h); } catch (_) { return { text: h, timestamp: Date.now() }; }
    });

    res.json({
      schedules,
      history,
      summary
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/schedules - create a new schedule
router.post('/schedules', requireAuth, async (req, res) => {
  try {
    const {
      contactJid,
      contactName,
      purpose,
      mode,
      exactText,
      repeat,
      repeatConfig,
      messagesPerSend,
      askMeFirst,
      sendEvenInQuietHours,
      endType,
      endDate,
      maxSends
    } = req.body;

    if (!contactJid) {
      return res.status(400).json({ error: 'contactJid is required' });
    }
    if (!purpose && !exactText) {
      return res.status(400).json({ error: 'purpose or exactText is required' });
    }

    const schedule = await createSchedule({
      contactJid,
      contactName,
      purpose,
      mode,
      exactText,
      repeat,
      repeatConfig,
      messagesPerSend,
      askMeFirst,
      sendEvenInQuietHours,
      endType,
      endDate,
      maxSends
    });

    res.json({ ok: true, schedule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/schedules/preview - preview AI message before saving
router.post('/schedules/preview', requireAuth, async (req, res) => {
  try {
    const preview = await previewScheduledMessage(req.body);
    res.json({ ok: true, preview });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chats/:jid/schedules - list schedules for contact
router.get('/chats/:jid/schedules', requireAuth, async (req, res) => {
  try {
    const jid = req.params.jid;
    const schedules = await listContactSchedules(jid);
    res.json({ schedules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/schedules/:id - get single schedule
router.get('/schedules/:id', requireAuth, async (req, res) => {
  try {
    const schedule = await getSchedule(req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
    res.json({ schedule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/schedules/:id - update schedule
router.put('/schedules/:id', requireAuth, async (req, res) => {
  try {
    const updated = await updateSchedule(req.params.id, req.body);
    res.json({ ok: true, schedule: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/schedules/:id - delete schedule
router.delete('/schedules/:id', requireAuth, async (req, res) => {
  try {
    const success = await deleteSchedule(req.params.id);
    res.json({ ok: success });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/schedules/:id/pause
router.post('/schedules/:id/pause', requireAuth, async (req, res) => {
  try {
    const schedule = await pauseSchedule(req.params.id);
    res.json({ ok: true, schedule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/schedules/:id/resume
router.post('/schedules/:id/resume', requireAuth, async (req, res) => {
  try {
    const schedule = await resumeSchedule(req.params.id);
    res.json({ ok: true, schedule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/schedules/:id/preview
router.post('/schedules/:id/preview', requireAuth, async (req, res) => {
  try {
    const schedule = await getSchedule(req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
    const preview = await previewScheduledMessage(schedule);
    res.json({ ok: true, preview });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/schedules/:id/run-now
router.post('/schedules/:id/run-now', requireAuth, async (req, res) => {
  try {
    const result = await runScheduleNow(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/schedules/:id/approve
router.post('/schedules/:id/approve', requireAuth, async (req, res) => {
  try {
    const { editedText } = req.body;
    const result = await approveScheduleSend(req.params.id, editedText);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/schedules/:id/reject
router.post('/schedules/:id/reject', requireAuth, async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await rejectScheduleSend(req.params.id, reason);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
