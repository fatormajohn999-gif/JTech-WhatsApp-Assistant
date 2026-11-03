import express from 'express';
import { state } from '../state.js';
import { logEvent } from '../lib/logger.js';
import { getSettings } from '../lib/settings.js';
import { DEFAULT_GEMINI_MODEL, DEFAULT_GROQ_MODEL } from '../config.js';
import {
  testGeminiProbe,
  testGroqProbe,
  getAvailableModels
} from '../ai/index.js';
import { requireAuth } from './auth.js';

const router = express.Router();

router.post('/test-ai', requireAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    const geminiModel = settings.geminiModel || DEFAULT_GEMINI_MODEL;
    const groqModel = settings.groqModel || DEFAULT_GROQ_MODEL;

    logEvent('info', `Running separate AI probe tests (25s timeout) for Gemini (${geminiModel}) and Groq (${groqModel})...`);

    const [geminiResult, groqResult] = await Promise.all([
      testGeminiProbe(geminiModel, 25000),
      testGroqProbe(groqModel, 25000)
    ]);

    state.lastAiTest = {
      gemini: geminiResult,
      groq: groqResult,
      testedAt: Date.now()
    };

    logEvent('info', `AI probe tests finished. Gemini: ${geminiResult.ok ? 'OK' : 'FAIL'} (${geminiResult.latencyMs}ms), Groq: ${groqResult.ok ? 'OK' : 'FAIL'} (${groqResult.latencyMs}ms)`);

    res.json({
      success: true,
      gemini: geminiResult,
      groq: groqResult,
      testedAt: state.lastAiTest.testedAt
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'TEST_AI_ERROR',
      hint: 'Could not complete AI probe tests.'
    });
  }
});

router.get('/models', requireAuth, async (req, res) => {
  try {
    const force = req.query.refresh === 'true';
    const models = await getAvailableModels(force);
    res.json(models);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: 'MODELS_FETCH_FAILED',
      hint: 'Failed to retrieve model listings.'
    });
  }
});

export default router;
