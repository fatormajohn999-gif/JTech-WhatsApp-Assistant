import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  BufferJSON,
  Browsers
} from '@whiskeysockets/baileys';
import { state } from '../state.js';
import { redis } from '../lib/redis.js';
import { logEvent } from '../lib/logger.js';
import { useUpstashAuthState, clearWhatsAppAuth } from './auth-store.js';
import { triggerPairingCodeIfRequested } from './pairing.js';
import { handleIncomingMessage } from './handler.js';

const logger = pino({ level: 'silent' });

// FIX: counts sockets so events from an old, replaced socket can be ignored
let socketGeneration = 0;

export function scheduleReconnect() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  const delay = Math.min(60000, 5000 * Math.pow(2, state.reconnectAttempts));
  state.reconnectAttempts++;
  state.setWhatsappState('reconnecting');
  logEvent('warn', `Recoverable disconnect. Reconnecting in ${delay / 1000}s (attempt ${state.reconnectAttempts})...`);
  state.reconnectTimer = setTimeout(() => {
    startWhatsApp();
  }, delay);
}

export async function startWhatsApp() {
  try {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    state.pairingCodeRequestedOnSocket = false;
    state.hasReceivedQrOrConnecting = false;
    state.connectingSince = 0;

    if (state.socketStartupWatchdog) {
      clearTimeout(state.socketStartupWatchdog);
      state.socketStartupWatchdog = null;
    }

    // 20-second watchdog: If no qr or connecting event arrives within 20s, show error and stop
    state.socketStartupWatchdog = setTimeout(() => {
      if (!state.hasReceivedQrOrConnecting && state.whatsappState !== 'connected') {
        const errorMsg = 'WhatsApp is not answering from this server (network or blocked address)';
        logEvent('error', errorMsg);
        state.setWhatsappState('error');
        state.setLastError({
          code: 'NETWORK_BLOCKED',
          message: errorMsg,
          hint: 'The WhatsApp servers did not respond within 20 seconds. Outgoing connections to WhatsApp ports may be blocked.'
        });
        if (state.reconnectTimer) {
          clearTimeout(state.reconnectTimer);
          state.reconnectTimer = null;
        }
        if (state.activePairingRequest) {
          const p = state.activePairingRequest;
          state.activePairingRequest = null;
          if (p.timer) clearTimeout(p.timer);
          p.reject(new Error(errorMsg));
        }
      }
    }, 20000);

    const myGeneration = ++socketGeneration;
    const { state: authState, saveCreds } = await useUpstashAuthState();
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logEvent('info', `Fetched Baileys version: ${Array.isArray(version) ? version.join('.') : version} (isLatest: ${isLatest})`);

    state.sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, logger)
      },
      browser: Browsers.ubuntu('Chrome'),
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 60000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });

    // FIX: an old socket must never overwrite the newer socket's saved creds
    state.sock.ev.on('creds.update', async () => {
      if (myGeneration !== socketGeneration) return;
      await saveCreds();
    });

    state.sock.ev.on('connection.update', async (update) => {
      // FIX: ignore events coming from a socket that has already been replaced
      if (myGeneration !== socketGeneration) return;
      const { connection, lastDisconnect, qr } = update;
      const qrPresent = qr ? 'yes' : 'no';
      const discCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode || 'none';
      const discMsg = lastDisconnect?.error?.message || 'none';

      logEvent('info', `connection.update: connection=${connection || 'none'}, qr=${qrPresent}, lastDisconnect code=${discCode}, message="${discMsg}"`);

      if (qr || connection === 'connecting') {
        state.hasReceivedQrOrConnecting = true;
        if (state.socketStartupWatchdog) {
          clearTimeout(state.socketStartupWatchdog);
          state.socketStartupWatchdog = null;
        }
      }

      if (qr) {
        state.latestQrString = qr;
        state.latestQrExpiresAt = Date.now() + 60000;
        try {
          state.latestQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
        } catch (qrErr) {
          logEvent('warn', `Failed to generate QR data URL: ${qrErr.message}`);
        }

        // Request pairing code on first QR event
        triggerPairingCodeIfRequested('first-qr-event', startWhatsApp);
      }

      if (connection === 'connecting') {
        if (!state.connectingSince) state.connectingSince = Date.now();
        if (state.whatsappState !== 'reconnecting' && state.whatsappState !== 'code_ready') {
          state.setWhatsappState('connecting');
        }

        setTimeout(() => {
          if (myGeneration !== socketGeneration) return;
          triggerPairingCodeIfRequested('connecting-2s', startWhatsApp);
        }, 2000);
      } else if (connection === 'open') {
        state.setWhatsappState('connected');
        state.clearPairing();
        state.lastError = null;
        state.reconnectAttempts = 0;
        logEvent('info', 'WhatsApp connection established successfully. JTech Assistant is online.');
      } else if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isRegistered = Boolean(state.sock?.authState?.creds?.registered);

        logEvent('warn', `WhatsApp connection closed. Status code: ${statusCode}, registered: ${isRegistered}`);

        if (statusCode === DisconnectReason.loggedOut) { // 401
          if (isRegistered) {
            logEvent('warn', 'Session logged out from device. Wiping credentials.');
            await clearWhatsAppAuth();
            state.setWhatsappState('logged_out');
            state.setLastError({
              code: 401,
              message: 'WhatsApp session was unlinked from phone',
              hint: 'Go to the Link screen to pair your WhatsApp account again.'
            });
            state.clearPairing();
          } else {
            logEvent('error', 'WhatsApp rejected the pairing attempt (401). Stopping retry loop.');
            // FIX: throw away the half-registered identity so the next attempt starts fresh
            await clearWhatsAppAuth();
            state.pairingCodeRequestedOnSocket = false;
            state.setWhatsappState('error');
            state.setLastError({
              code: 401,
              message: 'WhatsApp rejected the pairing attempt (401)',
              hint: 'Wait a few minutes, remove old linked devices in WhatsApp Settings > Linked devices, then try once.'
            });
            state.clearPairing();
          }
        } else if (statusCode === 408 || statusCode === DisconnectReason.timedOut || statusCode === DisconnectReason.connectionLost || statusCode === DisconnectReason.restartRequired) {
          if (isRegistered) {
            scheduleReconnect();
          } else {
            if (state.currentPairingCode && state.pairingExpiresAt > Date.now()) {
              logEvent('info', 'Recoverable timeout while pairing code is pending. Waiting for user code entry.');
              state.setWhatsappState('code_ready');
            } else {
              state.setWhatsappState('not_linked');
            }
          }
        } else {
          if (isRegistered) {
            scheduleReconnect();
          } else {
            state.setWhatsappState('not_linked');
          }
        }
      }
    });

    state.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (myGeneration !== socketGeneration) return;
      if (type !== 'notify') return;

      for (const m of messages) {
        try {
          await handleIncomingMessage(m);
        } catch (err) {
          console.error('[WhatsApp] Safe-caught message error:', err.message);
        }
      }
    });

  } catch (err) {
    logEvent('error', `Critical WhatsApp startup error: ${err.message}`);
    state.setWhatsappState('error');
    state.setLastError({
      code: 500,
      message: err.message,
      hint: 'Check server logs or restart WhatsApp from Settings.'
    });
  }
}

export async function initWhatsAppOnStartup() {
  try {
    const rawCreds = await redis.get('wa:creds');
    if (rawCreds) {
      const parsed = JSON.parse(rawCreds, BufferJSON.reviver);
      if (parsed?.registered) {
        logEvent('info', 'Found existing registered WhatsApp session. Connecting...');
        state.setWhatsappState('connecting');
        startWhatsApp();
        return;
      }
    }
    logEvent('info', 'No registered WhatsApp session found in Redis. Awaiting user pairing.');
    state.setWhatsappState('not_linked');
  } catch (e) {
    logEvent('warn', `Startup session check error: ${e.message}`);
    state.setWhatsappState('not_linked');
  }
}

export async function logoutWhatsApp() {
  if (state.sock) {
    try {
      await state.sock.logout();
    } catch (_) {}
  }
  await clearWhatsAppAuth();
  state.setWhatsappState('not_linked');
  state.clearPairing();
  state.lastError = null;
}
