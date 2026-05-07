// src/risk/manager.ts
// Risk management: position tracking, stop-loss, RSI-based exit signals

import { EventEmitter } from 'events';
import { StochasticRSI } from 'technicalindicators';
import { config } from '../config';
import { logger } from '../utils/logger';
import { Position, SignalResult, OHLCVCandle } from '../utils/types';
import { PositionStore } from '../utils/store';

const MODULE = 'RISK';

// RSI exit threshold — sesuai guide Obicle: exit saat RSI di puncak
const RSI_PEAK_EXIT_THRESHOLD = 80;
// RSI stop-loss threshold — keluar paksa kalau RSI sudah drop terlalu dalam dari peak
const RSI_STOP_THRESHOLD = 15;

export interface ExitSignal {
  position: Position;
  reason: 'RSI_PEAK' | 'RSI_DROP' | 'STOP_LOSS_PCT' | 'TAKE_PROFIT_PCT';
  currentPrice: number;
  pnlPct: number;
  stochRsiK?: number;
  stochRsiD?: number;
  message: string;
}

export class RiskManager extends EventEmitter {
  private positions: Map<string, Position> = new Map();
  private pendingApprovals: Set<string> = new Set();
  // Track kalau RSI sudah pernah peak untuk posisi ini (biar ga spam alert)
  private rsiPeakAlerted: Set<string> = new Set();
  // Harga terakhir — diupdate dari monitor cycle tiap 2 menit
  private lastKnownPrices: Map<string, number> = new Map();
  private store: PositionStore | null = null;

  /**
   * Inject store untuk persistence. Dipanggil dari orchestrator setelah construction.
   */
  setStore(store: PositionStore): void {
    this.store = store;
    const loaded = store.getPositionsMap();
    if (loaded.size > 0) {
      this.positions = loaded;
      const open = Array.from(this.positions.values()).filter(p => p.status === 'OPEN').length;
      logger.info(MODULE, `Restored ${loaded.size} positions from disk (${open} OPEN)`);
    }
  }

  private save(): void {
    if (this.store) {
      this.store.setPositionsMap(this.positions);
    }
  }

  canTrade(tokenAddress: string): { allowed: boolean; reason?: string } {
    const openPositions = this.getOpenPositions();
    if (openPositions.length >= config.risk.maxOpenPositions) {
      return {
        allowed: false,
        reason: `Max positions reached (${openPositions.length}/${config.risk.maxOpenPositions})`,
      };
    }

    const existingPosition = Array.from(this.positions.values()).find(
      (p) => p.tokenAddress === tokenAddress && p.status === 'OPEN'
    );
    if (existingPosition) {
      return { allowed: false, reason: `Already have open position for ${tokenAddress.slice(0, 8)}` };
    }

    if (this.pendingApprovals.has(tokenAddress)) {
      return { allowed: false, reason: `Approval already pending for ${tokenAddress.slice(0, 8)}` };
    }

    return { allowed: true };
  }

  registerPendingApproval(tokenAddress: string): void {
    this.pendingApprovals.add(tokenAddress);
    setTimeout(() => { this.pendingApprovals.delete(tokenAddress); }, 5 * 60 * 1000);
  }

  clearPendingApproval(tokenAddress: string): void {
    this.pendingApprovals.delete(tokenAddress);
  }

  addPosition(position: Position): void {
    this.positions.set(position.id, position);
    this.clearPendingApproval(position.tokenAddress);
    this.rsiPeakAlerted.delete(position.id); // reset on new position
    logger.info(MODULE, `Position opened: ${position.symbol} | ${position.amountSol} SOL`);
    this.emit('position:opened', position);
    this.save();
  }

  closePosition(positionId: string, exitPriceUsd: number): Position | null {
    const position = this.positions.get(positionId);
    if (!position) return null;

    position.status = 'CLOSED';
    position.exitPriceUsd = exitPriceUsd;
    position.exitTimestamp = Date.now();
    position.pnlPct = ((exitPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;
    this.positions.set(positionId, position);
    this.rsiPeakAlerted.delete(positionId);

    logger.info(MODULE, `Position closed: ${position.symbol} | PnL: ${position.pnlPct.toFixed(2)}%`);
    this.emit('position:closed', { position, exitPriceUsd, pnlPct: position.pnlPct });
    this.save();

    return position;
  }

  getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).filter((p) => p.status === 'OPEN');
  }

  getLastKnownPrice(tokenAddress: string): number | undefined {
    return this.lastKnownPrices.get(tokenAddress);
  }

  /**
   * Update harga terkini — dipanggil dari monitor cycle
   */
  updatePrices(prices: Map<string, number>): void {
    prices.forEach((price, addr) => {
      if (price > 0) this.lastKnownPrices.set(addr, price);
    });
  }

  /**
   * ── EXIT SIGNAL CHECK (Obicle strategy) ──────────────────────────────────
   * Di-call dari monitor cycle tiap 2 menit.
   * Checks (dalam urutan prioritas):
   *  1. RSI Peak (>80)    → EXIT SIGNAL sesuai PDF
   *  2. RSI Drop (<15)    → RSI sudah balik turun dari peak, konfirmasi exit
   *  3. Stop Loss %       → fallback kalau RSI tidak sempat peak
   *  4. Take Profit %     → fallback profit target
   */
  checkExitSignals(
    currentPrices: Map<string, number>,
    currentOHLCV: Map<string, OHLCVCandle[]>
  ): ExitSignal[] {
    const exits: ExitSignal[] = [];

    for (const position of this.getOpenPositions()) {
      const currentPrice = currentPrices.get(position.tokenAddress);
      if (!currentPrice || currentPrice <= 0) continue;

      const pnlPct = ((currentPrice - position.entryPriceUsd) / position.entryPriceUsd) * 100;
      const ohlcv = currentOHLCV.get(position.tokenAddress);

      // ── 1 & 2: RSI-based exit (dari PDF Obicle) ──
      if (ohlcv && ohlcv.length >= 40) {
        const stochRsi = this.calculateStochRSI(ohlcv.map(c => c.close));

        if (stochRsi) {
          const { k, d } = stochRsi;

          // RSI Peak: K dan D keduanya di atas threshold → alert jual
          if (k >= RSI_PEAK_EXIT_THRESHOLD && d >= RSI_PEAK_EXIT_THRESHOLD) {
            if (!this.rsiPeakAlerted.has(position.id)) {
              this.rsiPeakAlerted.add(position.id);
              const signal: ExitSignal = {
                position,
                reason: 'RSI_PEAK',
                currentPrice,
                pnlPct,
                stochRsiK: k,
                stochRsiD: d,
                message:
                  `📈 RSI PEAK — pertimbangkan jual sekarang\n` +
                  `Stoch RSI K: ${k.toFixed(1)} D: ${d.toFixed(1)}\n` +
                  `PnL saat ini: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`,
              };
              logger.warn(MODULE, `RSI PEAK: ${position.symbol} K:${k.toFixed(1)} D:${d.toFixed(1)} PnL:${pnlPct.toFixed(2)}%`);
              exits.push(signal);
              this.emit('exitSignal', signal);
            }
          }

          // RSI Drop setelah peak: K balik turun ke bawah 40 setelah sempat di atas 80
          // Ini sinyal konfirmasi bahwa momentum sudah berbalik
          if (this.rsiPeakAlerted.has(position.id) && k < 40 && d < 40) {
            const signal: ExitSignal = {
              position,
              reason: 'RSI_DROP',
              currentPrice,
              pnlPct,
              stochRsiK: k,
              stochRsiD: d,
              message:
                `📉 RSI TURUN SETELAH PEAK — momentum berbalik\n` +
                `RSI sudah drop dari peak: K:${k.toFixed(1)} D:${d.toFixed(1)}\n` +
                `PnL saat ini: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`,
            };
            logger.warn(MODULE, `RSI DROP after peak: ${position.symbol} K:${k.toFixed(1)} PnL:${pnlPct.toFixed(2)}%`);
            exits.push(signal);
            this.emit('exitSignal', signal);
            this.rsiPeakAlerted.delete(position.id); // reset agar bisa detect peak lagi
          }
        }
      }

      // ── 3: Stop Loss % (safety net) ──
      if (pnlPct <= -config.risk.stopLossPct) {
        const signal: ExitSignal = {
          position,
          reason: 'STOP_LOSS_PCT',
          currentPrice,
          pnlPct,
          message:
            `🚨 STOP LOSS TRIGGERED — JUAL SEGERA\n` +
            `Loss: ${pnlPct.toFixed(2)}% (threshold: -${config.risk.stopLossPct}%)`,
        };
        logger.warn(MODULE, `STOP LOSS: ${position.symbol} PnL:${pnlPct.toFixed(2)}%`);
        exits.push(signal);
        this.emit('exitSignal', signal);
      }

      // ── 4: Take Profit % (opsional alert kalau RSI belum peak) ──
      else if (pnlPct >= config.risk.takeProfitPct) {
        // Hanya alert kalau RSI belum peak (biar tidak double-alert)
        if (!this.rsiPeakAlerted.has(position.id)) {
          const signal: ExitSignal = {
            position,
            reason: 'TAKE_PROFIT_PCT',
            currentPrice,
            pnlPct,
            message:
              `🎯 TARGET PROFIT TERCAPAI\n` +
              `Profit: +${pnlPct.toFixed(2)}% | Tunggu RSI peak untuk exit optimal`,
          };
          logger.info(MODULE, `TAKE PROFIT: ${position.symbol} PnL:+${pnlPct.toFixed(2)}%`);
          exits.push(signal);
          this.emit('exitSignal', signal);
        }
      }
    }

    return exits;
  }

  /**
   * Helper: hitung Stoch RSI dari array close prices
   */
  private calculateStochRSI(closes: number[]): { k: number; d: number } | null {
    if (closes.length < 40) return null;
    try {
      const values = StochasticRSI.calculate({
        values: closes,
        rsiPeriod: 14,
        stochasticPeriod: 14,
        kPeriod: 3,
        dPeriod: 3,
      });
      if (!values.length) return null;
      const last = values[values.length - 1];
      return { k: last.k ?? 0, d: last.d ?? 0 };
    } catch {
      return null;
    }
  }

  /**
   * Position summary dengan PnL — diupdate tiap 2 menit dari monitor cycle
   */
  getPositionSummary(): string {
    const open = this.getOpenPositions();
    if (open.length === 0) return '📭 Tidak ada open position';

    return open.map((p) => {
      const age = Math.floor((Date.now() - p.entryTimestamp) / 60000);
      const ageStr = age < 60 ? `${age}m` : `${Math.floor(age/60)}h ${age%60}m`;
      const rsiPeak = this.rsiPeakAlerted.has(p.id) ? ' ⚡' : '';

      // Hitung PnL kalau ada harga terkini
      const currentPrice = this.lastKnownPrices.get(p.tokenAddress);
      let pnlStr = '_harga belum diupdate_';
      if (currentPrice && p.entryPriceUsd > 0) {
        const pnlPct = ((currentPrice - p.entryPriceUsd) / p.entryPriceUsd) * 100;
        const pnlEmoji = pnlPct >= 0 ? '📈' : '📉';
        pnlStr = `${pnlEmoji} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
      }

      return (
        `• *${p.symbol}*${rsiPeak} | ${p.amountSol} SOL | ${ageStr}\n` +
        `  Entry: $${p.entryPriceUsd.toFixed(8)} | PnL: ${pnlStr}`
      );
    }).join('\n');
  }

  evaluateSignal(signal: SignalResult): { shouldAlert: boolean; reason?: string } {
    const check = this.canTrade(signal.token.address);
    if (!check.allowed) return { shouldAlert: false, reason: check.reason };

    if (signal.token.priceChangePct1h > 200) {
      return { shouldAlert: false, reason: `Price pumped >200% in 1h - FOMO risk` };
    }
    if (signal.token.holders > 0 && signal.token.holders < 50) {
      return { shouldAlert: false, reason: `Too few holders (${signal.token.holders})` };
    }
    return { shouldAlert: true };
  }
}
