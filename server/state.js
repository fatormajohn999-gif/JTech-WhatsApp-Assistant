import { logEvent } from './lib/logger.js';

class ServerState {
  constructor() {
    this.sock = null;
    this.whatsappState = 'not_linked'; // 'not_linked' | 'connecting' | 'code_ready' | 'connected' | 'reconnecting' | 'logged_out' | 'error'
    this.whatsappStateSince = Date.now();
    this.currentPairingCode = null;
    this.pairingExpiresAt = 0;
    this.activePhone = '';
    this.lastError = null; // { code, message, hint, at }

    this.latestQrString = null;
    this.latestQrDataUrl = null;
    this.latestQrExpiresAt = 0;
    this.hasReceivedQrOrConnecting = false;
    this.socketStartupWatchdog = null;
    this.connectingSince = 0;
    this.pairingCodeRequestedOnSocket = false;
    this.activePairingRequest = null; // { phone, resolve, reject, timer, hasRetried }
    this.isPairingInProgress = false;

    this.reconnectAttempts = 0;
    this.reconnectTimer = null;

    this.botSentMessageIds = new Set();

    this.consecutiveFailures = 0;
    this.autoPauseUntil = 0;
    this.lastAiTest = null;
    this.isFirstAiCall = true;

    this.cachedSettings = null;
    this.lastSettingsFetch = 0;

    this.cachedModels = null;
    this.lastModelsFetch = 0;
  }

  setWhatsappState(newState) {
    if (this.whatsappState !== newState) {
      this.whatsappState = newState;
      this.whatsappStateSince = Date.now();
      logEvent('info', `WhatsApp state changed: ${newState}`);
    }
  }

  setLastError(err) {
    this.lastError = err ? {
      code: err.code || 500,
      message: err.message || String(err),
      hint: err.hint || '',
      at: Date.now()
    } : null;
  }

  clearPairing() {
    this.currentPairingCode = null;
    this.pairingExpiresAt = 0;
    this.latestQrString = null;
    this.latestQrDataUrl = null;
    this.latestQrExpiresAt = 0;
  }
}

export const state = new ServerState();
