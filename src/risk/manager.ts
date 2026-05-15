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

// ── Risk Config ──
const TRAILING_STOP_ENABLED = (process.env.TRAILING_STOP_ENABLED ?? 'true') === 'true';
const TRAILING_STOP_ACTIVATION_PCT = parseFloat(process.env.TRAILING_STOP_ACTIVATION_PCT ?? '15');
const TRAILING_STOP_DISTANCE_PCT = parseFloat(process.env.TRAILING_STOP_DISTANCE_PCT ?? '10');
const PARTIAL_TP_ENABLED = (process.env.PARTIAL_TP_ENABLED ?? 'true') === 'true';
const PARTIAL_TP_PCT = parseFloat(process.env.PARTIAL_TP_PCT ?? '30');
const PARTIAL_TP_SIZE_PCT = parseFloat(process.env.PARTIAL_TP_SIZE_PCT ?? '50');
const TIME_EXIT_MINUTES = parseInt(process.env.TIME_EXIT_MINUTES ?? '240'); // 4 hours
const TIME_EXIT_PNL_THRESHOLD = parseFloat(process.env.TIME_EXIT_PNL_THRESHOLD ?? '-2');

export interface ExitSignal {
  position: Position;
  reason: 'RSI_PEAK' | 'RSI_DROP' | 'STOP_LOSS_PCT' | 'TAKE_PROFIT_PCT' | 'TRAILING_STOP' | 'PARTIAL_PROFIT' | 'TIME_EXIT';
  currentPrice: number;
  pnlPct: number;
  stochRsiK?: number;
  stochRsiD?: number;
  message: string;
  isPartial?: boolean;
}

export class RiskManager extends EventEmitter {
  private positions: Map<string, Position> = new Map();
  private pendingApprovals: Set<string> = new Set();
  // Track alert yang sudah dikirim (biar ga spam tiap cycle)
  private rsiPeakAlerted: Set<string> = new Set();
  private stopLossAlerted: Set<string> = new Set();
  private takeProfitAlerted: Set<string> = new Set();
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
    const existing = Array.from(this.positions.values()).find(
      (p) => p.tokenAddress === position.tokenAddress && p.status === 'OPEN'
    );

    if (existing) {
      // ── CONSOLIDATE: merge ke posisi yang sudah ada ──
      const totalTokens = existing.tokensReceived + position.tokensReceived;
      const totalSol = existing.amountSol + position.amountSol;

      // Weighted average entry price (berbasis tokensReceived)
      const newEntryPrice = totalTokens > 0
        ? ((existing.entryPriceUsd * existing.tokensReceived) + (position.entryPriceUsd * position.tokensReceived)) / totalTokens
        : existing.entryPriceUsd;

      existing.amountSol = totalSol;
      existing.tokensReceived = totalTokens;
      existing.tokensReceivedRaw = String(
        parseInt(existing.tokensReceivedRaw || String(Math.floor(existing.tokensReceived)), 10) +
        parseInt(position.tokensReceivedRaw || String(Math.floor(position.tokensReceived)), 10)
      );
      existing.entryPriceUsd = newEntryPrice;
      // txSignature disimpan sebagai array gabungan (string) untuk tracking
      existing.txSignature = `${existing.txSignature},${position.txSignature}`;

      this.positions.set(existing.id, existing);
      this.clearPendingApproval(position.tokenAddress);
      logger.info(MODULE, `Position consolidated: ${existing.symbol} | +${position.amountSol} SOL → total ${totalSol.toFixed(3)} SOL | avg entry $${newEntryPrice.toFixed(8)}`);
      this.emit('position:opened', existing);
      this.save();
      return;
    }

    // ── NEW POSITION ──
    this.positions.set(position.id, position);
    this.clearPendingApproval(position.tokenAddress);
    this.rsiPeakAlerted.delete(position.id); // reset on new position
    logger.info(MODULE, `Position opened: ${position.symbol} | ${position.amountSol} SOL`);
    this.emit('position:opened', position);
    this.save();
  }

  closePosition(positionId: string, exitPriceUsd: number): Position | null {
    const position = this.positions.get(positionId);
    if (!position || position.status !== 'OPEN') return null;

    position.status = 'CLOSED';
    position.exitPriceUsd = exitPriceUsd;
    position.exitTimestamp = Date.now();
    position.pnlPct = ((exitPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;
    this.positions.set(positionId, position);
    // Clear semua alert tracking untuk position ini
    this.rsiPeakAlerted.delete(positionId);
    this.stopLossAlerted.delete(positionId);
    this.takeProfitAlerted.delete(positionId);

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
   * ── EXIT SIGNAL CHECK v2 ────────────────────────────────────────────────
   * Di-call dari monitor cycle tiap 2 menit.
   * Checks (dalam urutan prioritas):
   *  1. Stop Loss %       → tight safety net (default 8%)
   *  2. Trailing Stop     → proteksi profit setelah +15%
   *  3. Partial Profit    → jual 50% di +30%
   *  4. Time Exit         → keluar kalau stagnan >4 jam
   *  5. RSI Peak (>80)    → exit saat RSI di puncak
   *  6. RSI Drop (<40)    → konfirmasi momentum berbalik
   *  7. Take Profit %     → fallback hard target
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

      // ── Update highest price for trailing stop ──
      if (!position.highestPriceUsd || currentPrice > position.highestPriceUsd) {
        position.highestPriceUsd = currentPrice;
        this.positions.set(position.id, position);
      }

      // ── 1: Stop Loss % (tight safety net) ──
      // In auto-SL mode, emit every monitor cycle until the position is closed.
      // This lets the orchestrator retry if Jupiter/Jito fails on the first attempt.
      const autoStopLoss = config.risk.autoStopLossEnabled;
      if (pnlPct <= -config.risk.stopLossPct && (autoStopLoss || !this.stopLossAlerted.has(position.id))) {
        if (!autoStopLoss) this.stopLossAlerted.add(position.id);
        const signal: ExitSignal = {
          position,
          reason: 'STOP_LOSS_PCT',
          currentPrice,
          pnlPct,
          message:
            `🚨 STOP LOSS TRIGGERED — ${autoStopLoss ? 'AUTO SELL' : 'JUAL SEGERA'}\n` +
            `Loss: ${pnlPct.toFixed(2)}% (threshold: -${config.risk.stopLossPct}%)`,
        };
        logger.warn(MODULE, `STOP LOSS: ${position.symbol} PnL:${pnlPct.toFixed(2)}%`);
        exits.push(signal);
        this.emit('exitSignal', signal);
        continue; // stop checking other signals
      }

      // ── 2: Trailing Stop ──
      if (TRAILING_STOP_ENABLED && position.highestPriceUsd) {
        const peakPnl = ((position.highestPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;
        if (peakPnl >= TRAILING_STOP_ACTIVATION_PCT) {
          const trailingThreshold = position.highestPriceUsd * (1 - TRAILING_STOP_DISTANCE_PCT / 100);
          if (currentPrice <= trailingThreshold) {
            const signal: ExitSignal = {
              position,
              reason: 'TRAILING_STOP',
              currentPrice,
              pnlPct,
              message:
                `🛡 TRAILING STOP — profit dikunci\n` +
                `Peak: +${peakPnl.toFixed(2)}% | Now: ${pnlPct.toFixed(2)}%\n` +
                `Jual sebelum profit hilang!`,
            };
            logger.warn(MODULE, `TRAILING STOP: ${position.symbol} peak:${peakPnl.toFixed(2)}% now:${pnlPct.toFixed(2)}%`);
            exits.push(signal);
            this.emit('exitSignal', signal);
            continue;
          }
        }
      }

      // ── 3: Partial Take Profit ──
      if (PARTIAL_TP_ENABLED && !position.partialExitDone && pnlPct >= PARTIAL_TP_PCT) {
        position.partialExitDone = true;
        this.positions.set(position.id, position);
        const signal: ExitSignal = {
          position,
          reason: 'PARTIAL_PROFIT',
          currentPrice,
          pnlPct,
          isPartial: true,
          message:
            `💰 PROFIT ALERT — keputusan jual manual\n` +
            `Profit: +${pnlPct.toFixed(2)}% | Pertimbangkan lock profit\n` +
            `Bot tidak auto-sell posisi profit`,
        };
        logger.info(MODULE, `PARTIAL TP: ${position.symbol} +${pnlPct.toFixed(2)}%`);
        exits.push(signal);
        this.emit('exitSignal', signal);
        // Don't continue — still monitor remaining position
      }

      // ── 4: Time-based Exit ──
      const ageMinutes = (Date.now() - position.entryTimestamp) / 60000;
      if (ageMinutes >= TIME_EXIT_MINUTES && pnlPct <= TIME_EXIT_PNL_THRESHOLD) {
        const signal: ExitSignal = {
          position,
          reason: 'TIME_EXIT',
          currentPrice,
          pnlPct,
          message:
            `⏰ TIME EXIT — posisi stagnan ${Math.floor(ageMinutes)} menit\n` +
            `PnL: ${pnlPct.toFixed(2)}% | Cut loss & cari opportunity lain`,
        };
        logger.warn(MODULE, `TIME EXIT: ${position.symbol} age:${Math.floor(ageMinutes)}m PnL:${pnlPct.toFixed(2)}%`);
        exits.push(signal);
        this.emit('exitSignal', signal);
        continue;
      }

      // ── 5 & 6: RSI-based exit ──
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
            this.rsiPeakAlerted.delete(position.id);
          }
        }
      }

      // ── 7: Hard Take Profit % ──
      if (pnlPct >= config.risk.takeProfitPct && !this.takeProfitAlerted.has(position.id)) {
        if (!this.rsiPeakAlerted.has(position.id)) {
          this.takeProfitAlerted.add(position.id);
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

      // Escape symbol untuk Telegram Markdown
      const safeSym = p.symbol.replace(/_/g, '\\_').replace(/\[/g, '\\[').replace(/\]/g, '\\]');

      // Hitung PnL kalau ada harga terkini
      const currentPrice = this.lastKnownPrices.get(p.tokenAddress);
      let pnlStr = '_harga belum diupdate_';
      if (currentPrice && p.entryPriceUsd > 0) {
        const pnlPct = ((currentPrice - p.entryPriceUsd) / p.entryPriceUsd) * 100;
        const pnlEmoji = pnlPct >= 0 ? '📈' : '📉';
        pnlStr = `${pnlEmoji} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
      }

      return (
        `• *${safeSym}*${rsiPeak} | ${p.amountSol} SOL | ${ageStr}\n` +
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

    // Skip LOW confidence — terlalu banyak noise, buruk untuk win rate
    if (signal.confidence === 'LOW') {
      return { shouldAlert: false, reason: `LOW confidence skipped (trend/volume too weak)` };
    }

    return { shouldAlert: true };
  }
}
