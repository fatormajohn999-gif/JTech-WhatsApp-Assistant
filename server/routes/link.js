import express from 'express';
import { state } from '../state.js';
import { requireAuth } from './auth.js';
import { executePairingRequest, cleanDigits } from '../whatsapp/pairing.js';
import { startWhatsApp } from '../whatsapp/socket.js';

const router = express.Router();

router.post('/link', requireAuth, async (req, res) => {
  try {
    const rawPhone = req.body.phone || req.body.phoneNumber || '';
    const digits = cleanDigits(rawPhone);

    if (!digits || digits.length < 7 || digits.length > 15) {
      return res.status(400).json({
        error: 'Please enter a valid phone number (country code + digits, no + sign)',
        code: 'INVALID_PHONE',
        hint: 'Example: 23276123456 or 15551234567 (digits only, no + sign, dashes, or spaces).'
      });
    }

    // Check if an unexpired code is already pending
    if (!req.body.force && state.currentPairingCode && state.pairingExpiresAt > Date.now()) {
      const secondsLeft = Math.max(0, Math.ceil((state.pairingExpiresAt - Date.now()) / 1000));
      return res.json({
        success: true,
        pairingCode: state.currentPairingCode,
        expiresAt: state.pairingExpiresAt,
        secondsLeft,
        phone: state.activePhone || digits
      });
    }

    if (state.isPairingInProgress) {
      return res.status(429).json({
        error: 'Pairing request is already in progress. Please wait a moment...',
        code: 'PAIRING_IN_PROGRESS',
        hint: 'Please wait for the current pairing attempt to complete.'
      });
    }

    state.isPairingInProgress = true;
    try {
      const code = await executePairingRequest(digits, startWhatsApp);
      const secondsLeft = Math.max(0, Math.ceil((state.pairingExpiresAt - Date.now()) / 1000));
      res.json({
        success: true,
        pairingCode: code,
        expiresAt: state.pairingExpiresAt,
        secondsLeft,
        phone: digits
      });
    } finally {
      state.isPairingInProgress = false;
    }
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: err.code || 'PAIRING_ERROR',
      hint: err.hint || state.lastError?.hint || 'Check that your phone number is correct and that WhatsApp is active on your device.'
    });
  }
});

export default router;
