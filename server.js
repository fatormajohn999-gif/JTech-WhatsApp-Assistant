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
const configuredOrigins = (ALLOWED_ORIGIN || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const defaultAllowedPrefixes = [
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'http://127.0.0.1'
];

app.use((req, res, next) => {
  const reqOrigin = req.headers.origin;
  let allowOrigin = '*';

  if (configuredOrigins.includes('*')) {
    allowOrigin = reqOrigin || '*';
  } else if (reqOrigin) {
    const isExplicit = configuredOrigins.includes(reqOrigin);
    const isDefault = defaultAllowedPrefixes.some(prefix => reqOrigin.startsWith(prefix));
    if (isExplicit || isDefault) {
      allowOrigin = reqOrigin;
    } else {
      allowOrigin = configuredOrigins[0] || '*';
    }
  }

  res.header('Access-Control-Allow-Origin', allowOrigin);
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-pass');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
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
