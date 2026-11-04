import express from 'express';
import { PORT, ALLOWED_ORIGIN } from './server/config.js';
import authRouter from './server/routes/auth.js';
import stateRouter from './server/routes/state.js';
import linkRouter from './server/routes/link.js';
import settingsRouter from './server/routes/settings.js';
import chatsRouter from './server/routes/chats.js';
import aiRouter from './server/routes/ai.js';
import learningRouter from './server/routes/learning.js';
import schedulesRouter from './server/routes/schedules.js';
import systemRouter, { initKeepAwake } from './server/routes/system.js';
import { initWhatsAppOnStartup } from './server/whatsapp/socket.js';
import { initDailySummaryScheduler } from './server/lib/daily-summary.js';
import { initScheduler } from './server/lib/scheduler.js';

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-pass');
  req.method === 'OPTIONS' ? res.sendStatus(204) : next();
});
app.use('/api', [authRouter, stateRouter, linkRouter, settingsRouter, chatsRouter, aiRouter, learningRouter, schedulesRouter]);
app.use(systemRouter);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`JTech Assistant online on port ${PORT}`);
  initWhatsAppOnStartup().catch(console.error);
  initKeepAwake();
  initDailySummaryScheduler();
  initScheduler();
});
