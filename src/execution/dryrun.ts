// src/execution/dryrun.ts
// Dry Run / Paper Trading Mode
//
// Ketika DRY_RUN=true:
//  - Scan, filter, indikator, simulasi semua berjalan NORMAL
//  - Jupiter quote tetap di-fetch (validasi price impact real)
//  - Tidak ada sign, tidak ada bundle, tidak ada on-chain tx
//  - Paper position dicatat di memory
//  - /positions di Telegram menampilkan paper PnL

import { config } from '../config';
import { logger } from '../utils/logger';
import { ApprovalRequest, Position } from '../utils/types';
import { RiskManager } from '../risk/manager';
import { TelegramBot } from '../telegram/bot';

const MODULE = 'DRYRUN';

// Paper trade result yang disimpan untuk laporan
export interface PaperTrade {
  id: string;
  symbol: string;
  tokenAddress: string;
  entryPriceUsd: number;
  amountSol: number;
  tokensSimulated: number;
  priceImpactPct: number;
  slippagePct: number;
  estimatedFeeSol: number;
  entryTimestamp: number;
  signalConfidence: string;
  emaTouched: number;
  stochRsiK: number;
  // Filled on close
  exitPriceUsd?: number;
  exitTimestamp?: number;
  pnlPct?: number;
  status: 'OPEN' | 'CLOSED';
}

export class DryRunExecutor {
  private paperTrades: Map<string, PaperTrade> = new Map();
  private riskManager: RiskManager;
  private telegramBot: TelegramBot;
  private tradeCounter: number = 0;

  constructor(riskManager: RiskManager, telegramBot: TelegramBot) {
    this.riskManager = riskManager;
    this.telegramBot = telegramBot;
  }

  /**
   * Simulate trade execution — no on-chain action, just record paper position
   */
  async simulateTrade(request: ApprovalRequest): Promise<void> {
    const { signal, tradeParams, quoteResult, simulationResult } = request;
    const token = signal.token;

    logger.info(MODULE, `📝 [DRY RUN] Simulating trade: ${token.symbol} | ${tradeParams.amountSol} SOL`);

    // Hitung paper entry price dari Jupiter quote
    // outAmount = jumlah token yang akan diterima
    const tokensSimulated = Number(quoteResult.outAmount);
    // harga per token dalam SOL, konversi ke USD
    const solPriceUsd = token.priceUsd > 0
      ? (tradeParams.amountSol * 150) / (tokensSimulated || 1) // fallback SOL ~$150
      : 0;
    const entryPriceUsd = token.priceUsd; // pakai harga market langsung

    const paperTradeId = `paper_${++this.tradeCounter}_${Date.now()}`;

    const paperTrade: PaperTrade = {
      id: paperTradeId,
      symbol: token.symbol,
      tokenAddress: token.address,
      entryPriceUsd,
      amountSol: tradeParams.amountSol,
      tokensSimulated,
      priceImpactPct: quoteResult.priceImpactPct,
      slippagePct: tradeParams.slippagePct,
      estimatedFeeSol: simulationResult.estimatedFeeSOL,
      entryTimestamp: Date.now(),
      signalConfidence: signal.confidence,
      emaTouched: signal.emaTouched,
      stochRsiK: signal.stochRsiK,
      status: 'OPEN',
    };

    this.paperTrades.set(paperTradeId, paperTrade);

    // Daftarkan sebagai real position di RiskManager supaya:
    // 1. canTrade() block token ini dari signal duplikat
    // 2. Monitor cycle bisa cek RSI exit
    const position: Position = {
      id: paperTradeId,
      tokenAddress: token.address,
      symbol: token.symbol,
      entryPriceUsd,
      amountSol: tradeParams.amountSol,
      tokensReceived: tokensSimulated,
      entryTimestamp: Date.now(),
      txSignature: `[DRY_RUN_${paperTradeId}]`,
      status: 'OPEN',
    };

    this.riskManager.addPosition(position);

    // Kirim notif ke Telegram
    await this.telegramBot.sendMessage(
      `📝 *[DRY RUN] PAPER TRADE SIMULATED*\n\n` +
      `🪙 *${token.symbol}*\n` +
      `💰 Size: ${tradeParams.amountSol} SOL (paper)\n` +
      `📊 Entry price: $${entryPriceUsd.toFixed(8)}\n` +
      `📉 Price impact: ${quoteResult.priceImpactPct.toFixed(3)}% ✅\n` +
      `⚡ Slippage: ${tradeParams.slippagePct}%\n` +
      `🔧 Est fee: ${simulationResult.estimatedFeeSOL.toFixed(6)} SOL\n` +
      `📈 Signal: EMA${signal.emaTouched} | RSI K:${signal.stochRsiK.toFixed(1)} | ${signal.confidence}\n\n` +
      `🔗 [DexScreener](https://dexscreener.com/solana/${token.address})\n\n` +
      `_Tidak ada transaksi nyata. Mode: DRY RUN_`
    );

    logger.info(MODULE, `✅ [DRY RUN] Paper position opened: ${token.symbol} @ $${entryPriceUsd.toFixed(8)}`);
  }

  /**
   * Update paper trade dengan harga terbaru (dipanggil dari monitor cycle)
   * Returns formatted PnL string untuk logging
   */
  updatePaperPrice(tokenAddress: string, currentPriceUsd: number): string | null {
    const trade = Array.from(this.paperTrades.values()).find(
      (t) => t.tokenAddress === tokenAddress && t.status === 'OPEN'
    );
    if (!trade || trade.entryPriceUsd <= 0) return null;

    const pnlPct = ((currentPriceUsd - trade.entryPriceUsd) / trade.entryPriceUsd) * 100;
    return `${trade.symbol} | entry:$${trade.entryPriceUsd.toFixed(8)} now:$${currentPriceUsd.toFixed(8)} PnL:${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
  }

  /**
   * Full paper trading report — dipanggil dari /dryreport command
   */
  generateReport(): string {
    const all = Array.from(this.paperTrades.values());
    if (!all.length) return '📭 Belum ada paper trade.';

    const open   = all.filter((t) => t.status === 'OPEN');
    const closed = all.filter((t) => t.status === 'CLOSED');

    let report = `📝 *DRY RUN REPORT*\n`;
    report += `_Semua ini adalah simulasi — tidak ada transaksi nyata_\n\n`;

    // ── Open positions ─────────────────────────────────────
    if (open.length) {
      report += `*🟢 Open (${open.length})*\n`;
      for (const t of open) {
        const age = Math.floor((Date.now() - t.entryTimestamp) / 60000);
        report += `• *${t.symbol}* | ${t.amountSol} SOL | ${age}m\n`;
        report += `  Entry: $${t.entryPriceUsd.toFixed(8)} | Impact: ${t.priceImpactPct.toFixed(2)}%\n`;
        report += `  Signal: EMA${t.emaTouched} RSI:${t.stochRsiK.toFixed(0)} [${t.signalConfidence}]\n`;
      }
      report += '\n';
    }

    // ── Closed positions ────────────────────────────────────
    if (closed.length) {
      const wins   = closed.filter((t) => (t.pnlPct ?? 0) > 0).length;
      const losses = closed.filter((t) => (t.pnlPct ?? 0) <= 0).length;
      const avgPnl = closed.reduce((a, t) => a + (t.pnlPct ?? 0), 0) / closed.length;

      report += `*📁 Closed (${closed.length})*\n`;
      report += `W/L: ${wins}W ${losses}L | Avg PnL: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%\n\n`;

      for (const t of closed) {
        const pnlStr = `${(t.pnlPct ?? 0) >= 0 ? '✅ +' : '❌ '}${(t.pnlPct ?? 0).toFixed(2)}%`;
        report += `• *${t.symbol}* ${pnlStr}\n`;
      }
    }

    // ── Summary ─────────────────────────────────────────────
    report += `\n*📊 Signal Quality (semua trade)*\n`;
    const byConfidence = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    all.forEach((t) => {
      byConfidence[t.signalConfidence as keyof typeof byConfidence]++;
    });
    report += `• HIGH: ${byConfidence.HIGH} | MEDIUM: ${byConfidence.MEDIUM} | LOW: ${byConfidence.LOW}\n`;
    report += `\n_Switch ke live: set DRY_RUN=false di .env_`;

    return report;
  }

  getPaperTrades(): PaperTrade[] {
    return Array.from(this.paperTrades.values());
  }

  getOpenPaperTrades(): PaperTrade[] {
    return this.getPaperTrades().filter((t) => t.status === 'OPEN');
  }
}
