// src/scanner/index.ts
// Smart Scanner Router
// Priority: GMGN → DexScreener fallback
// Also handles free RPC rotation on 429 errors

import { Connection } from '@solana/web3.js';
import { GMGNScanner } from './gmgn';
import { DexScreenerScanner } from './dexscreener';
import { config, FREE_RPC_ENDPOINTS } from '../config';
import { logger } from '../utils/logger';
import { TokenInfo } from '../utils/types';

const MODULE = 'SCANNER_ROUTER';

// ── RPC Rotation ──────────────────────────────────────────────
// For free-tier users: rotate between public endpoints to spread rate limits

export class RPCConnectionManager {
  private endpoints: readonly string[];
  private currentIndex: number = 0;
  private connections: Map<string, Connection> = new Map();

  constructor() {
    // Build endpoint list: user config first, then free fallbacks
    const primary = config.rpc.url;
    const extras   = config.rpc.fallbackUrls;
    this.endpoints = [primary, ...extras];
    logger.info(MODULE, `RPC pool: ${this.endpoints.length} endpoint(s)`);
  }

  getConnection(): Connection {
    const url = this.endpoints[this.currentIndex];

    if (!this.connections.has(url)) {
      this.connections.set(
        url,
        new Connection(url, { commitment: 'confirmed' })
      );
    }

    return this.connections.get(url)!;
  }

  /**
   * Rotate to next RPC endpoint (called on 429 / timeout)
   */
  rotate(): void {
    const prev = this.endpoints[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.endpoints.length;
    const next = this.endpoints[this.currentIndex];
    logger.warn(MODULE, `RPC rotated: ${prev} → ${next}`);
  }

  getCurrentUrl(): string {
    return this.endpoints[this.currentIndex];
  }
}

// ── Scanner Health Tracking ───────────────────────────────────

interface ScannerHealth {
  consecutiveFailures: number;
  lastSuccess: number;
  isCircuitOpen: boolean;
}

const CIRCUIT_BREAKER_THRESHOLD = 3;    // failures before circuit opens
const CIRCUIT_RESET_MS = 5 * 60 * 1000; // 5 min cooldown

// ── Smart Scanner Router ──────────────────────────────────────

export class ScannerRouter {
  private gmgn: GMGNScanner;
  private dexscreener: DexScreenerScanner;

  private gmgnHealth: ScannerHealth = {
    consecutiveFailures: 0,
    lastSuccess: Date.now(),
    isCircuitOpen: false,
  };

  private lastSource: 'gmgn' | 'dexscreener' | null = null;

  constructor() {
    this.gmgn = new GMGNScanner();
    this.dexscreener = new DexScreenerScanner();
  }

  /**
   * Main scan: try GMGN first, auto-fallback to DexScreener
   */
  async scan(): Promise<{ tokens: TokenInfo[]; source: 'gmgn' | 'dexscreener' }> {
    // Check if GMGN circuit breaker is open
    if (this.gmgnHealth.isCircuitOpen) {
      const timeSinceOpen = Date.now() - this.gmgnHealth.lastSuccess;
      if (timeSinceOpen > CIRCUIT_RESET_MS) {
        // Try to reset circuit
        logger.info(MODULE, 'GMGN circuit breaker resetting — trying again...');
        this.gmgnHealth.isCircuitOpen = false;
        this.gmgnHealth.consecutiveFailures = 0;
      } else {
        const remainSec = Math.floor((CIRCUIT_RESET_MS - timeSinceOpen) / 1000);
        logger.info(MODULE, `GMGN circuit open. Using DexScreener (resets in ${remainSec}s)`);
        return this.scanWithDexScreener();
      }
    }

    // --- Try GMGN primary ---
    try {
      logger.debug(MODULE, 'Trying GMGN (primary)...');
      const tokens = await withTimeout(this.gmgn.scan(), 25_000, 'GMGN timeout');

      if (tokens.length === 0) {
        throw new Error('GMGN returned empty result');
      }

      // Success — reset failure counter
      this.gmgnHealth.consecutiveFailures = 0;
      this.gmgnHealth.lastSuccess = Date.now();
      this.lastSource = 'gmgn';

      logger.info(MODULE, `✅ Source: GMGN (${tokens.length} tokens)`);
      return { tokens, source: 'gmgn' };

    } catch (err) {
      this.gmgnHealth.consecutiveFailures++;
      logger.warn(
        MODULE,
        `GMGN failed (${this.gmgnHealth.consecutiveFailures}/${CIRCUIT_BREAKER_THRESHOLD}): ${(err as Error).message}`
      );

      // Open circuit breaker after N consecutive failures
      if (this.gmgnHealth.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.gmgnHealth.isCircuitOpen = true;
        logger.warn(MODULE, `⚡ GMGN circuit OPEN — switching to DexScreener for ${CIRCUIT_RESET_MS / 60000}min`);
      }

      // --- Fallback to DexScreener ---
      logger.info(MODULE, '⬇️  Falling back to DexScreener...');
      return this.scanWithDexScreener();
    }
  }

  private async scanWithDexScreener(): Promise<{ tokens: TokenInfo[]; source: 'dexscreener' }> {
    try {
      const tokens = await withTimeout(this.dexscreener.scan(), 20_000, 'DexScreener timeout');
      this.lastSource = 'dexscreener';

      if (tokens.length === 0) {
        logger.warn(MODULE, 'DexScreener also returned empty — market may be quiet');
      } else {
        logger.info(MODULE, `✅ Source: DexScreener (${tokens.length} tokens)`);
      }

      return { tokens, source: 'dexscreener' };
    } catch (err) {
      logger.error(MODULE, 'DexScreener fallback also failed', err);
      return { tokens: [], source: 'dexscreener' };
    }
  }

  /**
   * Get current health status — useful for Telegram /status command
   */
  getHealthStatus(): string {
    const gmgnStatus = this.gmgnHealth.isCircuitOpen
      ? '🔴 Circuit Open (using fallback)'
      : this.gmgnHealth.consecutiveFailures > 0
        ? `🟡 Degraded (${this.gmgnHealth.consecutiveFailures} failures)`
        : '🟢 Healthy';

    return (
      `📡 *Scanner Status*\n` +
      `• GMGN: ${gmgnStatus}\n` +
      `• DexScreener: 🟢 Available (free fallback)\n` +
      `• Last source: ${this.lastSource ?? 'none'}`
    );
  }
}

// ── Utility: Promise with timeout ────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} (${ms}ms)`)), ms)
    ),
  ]);
}
