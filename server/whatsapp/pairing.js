import { state } from '../state.js';
import { logEvent } from '../lib/logger.js';

export function cleanDigits(val) {
  if (!val) return '';
  return String(val).replace(/\D/g, '');
}

export async function triggerPairingCodeIfRequested(source, startWhatsAppFn) {
  if (!state.activePairingRequest) return;
  if (state.pairingCodeRequestedOnSocket) return;
  if (!state.sock || state.sock.authState?.creds?.registered) return;

  const phone = state.activePairingRequest.phone;
  state.pairingCodeRequestedOnSocket = true;
  logEvent('info', `Triggering requestPairingCode(+${phone}) via ${source}...`);

  try {
    const code = await state.sock.requestPairingCode(phone);
    state.currentPairingCode = code;
    state.pairingExpiresAt = Date.now() + 60000;
    state.activePhone = phone;
    state.setWhatsappState('code_ready');
    state.lastError = null;
    logEvent('info', `Pairing code generated successfully: ${code} (expires in 60s)`);

    if (state.activePairingRequest) {
      const p = state.activePairingRequest;
      state.activePairingRequest = null;
      if (p.timer) clearTimeout(p.timer);
      p.resolve(code);
    }
  } catch (err) {
    logEvent('error', `requestPairingCode failed: ${err.message}`);
    const errText = `${err?.message || ''} ${err?.toString() || ''}`;
    const isConnClosed = /connection closed/i.test(errText) || (err?.output?.statusCode === 428);

    if (isConnClosed && !state.activePairingRequest?.hasRetried) {
      logEvent('warn', 'requestPairingCode threw "Connection Closed". Waiting 15s to recreate socket and retry once...');
      state.setWhatsappState('reconnecting');
      if (state.activePairingRequest) state.activePairingRequest.hasRetried = true;

      setTimeout(async () => {
        try {
          if (state.sock) {
            try { state.sock.end(undefined); } catch (_) {}
            state.sock = null;
          }
          if (typeof startWhatsAppFn === 'function') {
            await startWhatsAppFn();
          }
        } catch (rErr) {
          logEvent('error', `Socket recreation failed: ${rErr.message}`);
          if (state.activePairingRequest) {
            const p = state.activePairingRequest;
            state.activePairingRequest = null;
            if (p.timer) clearTimeout(p.timer);
            p.reject(rErr);
          }
        }
      }, 15000);
    } else {
      state.setLastError({
        code: 500,
        message: err.message || 'WhatsApp pairing code request failed',
        hint: 'Verify phone number format. If WhatsApp closed the connection, wait 2 minutes before retrying.'
      });
      state.setWhatsappState('error');
      if (state.activePairingRequest) {
        const p = state.activePairingRequest;
        state.activePairingRequest = null;
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
    }
  }
}

export async function executePairingRequest(phoneInput, startWhatsAppFn) {
  const digitsOnlyPhone = cleanDigits(phoneInput);
  if (!digitsOnlyPhone || digitsOnlyPhone.length < 7 || digitsOnlyPhone.length > 15) {
    const err = new Error('Invalid phone number. Enter full international number with country code (digits only).');
    err.code = 'INVALID_PHONE';
    err.hint = 'Example: 23276123456 or 15551234567. Do not include + or spaces.';
    throw err;
  }

  if (state.sock?.authState?.creds?.registered) {
    const err = new Error('WhatsApp is already linked to a registered device.');
    err.code = 'ALREADY_LINKED';
    err.hint = 'To pair a new device or number, first unlink WhatsApp in Settings.';
    throw err;
  }

  if (state.activePairingRequest?.timer) clearTimeout(state.activePairingRequest.timer);

  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => {
      if (state.activePairingRequest) {
        state.activePairingRequest = null;
        reject(new Error('Timed out waiting for WhatsApp pairing response'));
      }
    }, 45000);

    state.activePairingRequest = {
      phone: digitsOnlyPhone,
      resolve,
      reject,
      timer,
      hasRetried: false
    };

    if (!state.sock || state.pairingCodeRequestedOnSocket) {
      logEvent('info', `Starting fresh WhatsApp socket for pairing request (+${digitsOnlyPhone})...`);
      if (state.sock) {
        try { state.sock.end(undefined); } catch (_) {}
        state.sock = null;
      }
      try {
        if (typeof startWhatsAppFn === 'function') {
          await startWhatsAppFn();
        }
      } catch (err) {
        state.activePairingRequest = null;
        clearTimeout(timer);
        return reject(err);
      }
    } else {
      if (state.latestQrString) {
        triggerPairingCodeIfRequested('immediate-qr-ready', startWhatsAppFn);
      } else if (state.connectingSince && (Date.now() - state.connectingSince >= 2000)) {
        triggerPairingCodeIfRequested('immediate-connecting-ready', startWhatsAppFn);
      }
    }
  });
}
