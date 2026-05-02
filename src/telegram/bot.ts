// src/telegram/bot.ts
// Telegraf Telegram bot — Alert + Manual Approval + Missed Signals

import { Telegraf, Markup, Context } from 'telegraf';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ApprovalRequest, SignalResult, QuoteResult, SimulationResult, TradeParams } from '../utils/types';
import type { ExitSignal } from '../risk/manager';
import { RiskManager } from '../risk/manager';
import type { ScannerRouter } from '../scanner/index';
import type { DryRunExecutor } from '../execution/dryrun';

const MODULE = 'TELEGRAM';

// TTL bisa dikonfigurasi — default 10 menit (lebih santai dari 5 menit sebelumnya)
const APPROVAL_TTL_MS = parseInt(process.env.APPROVAL_TTL_MINUTES ?? '10') * 60 * 1000;
// Reminder dikirim di 50% TTL (misal TTL 10 menit → reminder menit ke-5)
const REMINDER_AT_MS  = Math.floor(APPROVAL_TTL_MS / 2);

interface MissedSignal {
  symbol: string;
  tokenAddress: string;
  confidence: string;
  emaTouched: number;
  stochRsiK: number;
  mcapUsd: number;
  expiredAt: number;
  reason: 'EXPIRED' | 'CANCELLED';
}

type ApprovalCallback = (request: ApprovalRequest) => Promise<void>;

export class TelegramBot {
  private bot: Telegraf;
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private onApproveCallback: ApprovalCallback | null = null;
  private riskManager: RiskManager;
  private missedSignals: MissedSignal[] = [];
  scannerRouter: ScannerRouter | null = null;
  dryRunExecutor: DryRunExecutor | null = null;

  constructor(riskManager: RiskManager) {
    this.bot = new Telegraf(config.telegram.botToken);
    this.riskManager = riskManager;
    this.setupHandlers();
  }

  // ── Handlers ─────────────────────────────────────────────────

  private setupHandlers(): void {

    // /start — show persistent keyboard menu
    this.bot.command('start', async (ctx) => {
      const modeLabel = config.dryRun ? '🧪 DRY RUN' : '🟢 LIVE';
      const keyboard = Markup.keyboard([
        ['📊 Status', '📂 Positions'],
        config.dryRun
          ? ['📝 Dry Report', '❓ Help']
          : ['❓ Help'],
        ['⏭ Missed Signals', '✖️ Tutup Menu'],
      ]).resize().persistent();

      await ctx.reply(
        `🤖 *VANGUARD-01 — Solana Degen Bot*\n\n` +
        `Mode saat ini: *${modeLabel}*\n\n` +
        `Bot scan otomatis tiap *${config.scanning.intervalSeconds / 60} menit*.\n` +
        `Alert dikirim ke sini saat ada signal masuk.\n\n` +
        `Pilih menu di bawah atau ketik command:`,
        { parse_mode: 'Markdown', ...keyboard }
      );
    });

    // Keyboard button taps
    this.bot.hears('📊 Status',        async (ctx) => this.handleStatus(ctx));
    this.bot.hears('📂 Positions',     async (ctx) => this.handlePositions(ctx));
    this.bot.hears('📝 Dry Report',    async (ctx) => this.handleDryReport(ctx));
    this.bot.hears('❓ Help',          async (ctx) => this.handleHelp(ctx));
    this.bot.hears('⏭ Missed Signals', async (ctx) => this.handleMissed(ctx));
    this.bot.hears('✖️ Tutup Menu',    async (ctx) => {
      await ctx.reply(
        'Menu disembunyikan. Ketik /start untuk tampilkan lagi.',
        Markup.removeKeyboard()
      );
    });

    // Slash commands
    this.bot.command('status',    async (ctx) => this.handleStatus(ctx));
    this.bot.command('positions', async (ctx) => this.handlePositions(ctx));
    this.bot.command('dryreport', async (ctx) => this.handleDryReport(ctx));
    this.bot.command('missed',    async (ctx) => this.handleMissed(ctx));
    this.bot.command('help',      async (ctx) => this.handleHelp(ctx));

    // APPROVE / CANCEL inline button callbacks
    this.bot.action(/^APPROVE_(.+)$/, async (ctx) => {
      await this.handleApproval(ctx, ctx.match[1], 'APPROVED');
    });
    this.bot.action(/^CANCEL_(.+)$/, async (ctx) => {
      await this.handleApproval(ctx, ctx.match[1], 'REJECTED');
    });

    // Inline refresh callbacks
    this.bot.action('STATUS_REFRESH', async (ctx) => {
      await ctx.answerCbQuery('Refreshing...');
      await ctx.deleteMessage().catch(() => {});
      await this.handleStatus(ctx);
    });
    this.bot.action('SHOW_POSITIONS', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.deleteMessage().catch(() => {});
      await this.handlePositions(ctx);
    });
    this.bot.action('SHOW_DRYREPORT', async (ctx) => {
      await ctx.answerCbQuery();
      await this.handleDryReport(ctx);
    });
    this.bot.action('CLEAR_MISSED', async (ctx) => {
      this.missedSignals = [];
      await ctx.answerCbQuery('✅ List cleared');
      await ctx.editMessageText('✅ Missed signals list dikosongkan.');
    });

    // Error handler
    this.bot.catch((err, ctx) => {
      logger.error(MODULE, `Telegraf error for ${ctx.updateType}`, err);
    });
  }

  // ── Shared handlers ──────────────────────────────────────────

  private async handleStatus(ctx: Context): Promise<void> {
    const openPos = this.riskManager.getOpenPositions().length;
    const pending = this.pendingApprovals.size;
    const scannerHealth = this.scannerRouter?.getHealthStatus() ?? '📡 Scanner: initializing';
    const uptime = process.uptime();
    const uptimeStr = uptime < 3600
      ? `${Math.floor(uptime / 60)}m`
      : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;
    const ttlMin = Math.floor(APPROVAL_TTL_MS / 60000);

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Refresh', 'STATUS_REFRESH'),
        Markup.button.callback('📂 Positions', 'SHOW_POSITIONS'),
      ],
      ...(config.dryRun
        ? [[Markup.button.callback('📝 Dry Report', 'SHOW_DRYREPORT')]]
        : []),
    ]);

    await ctx.reply(
      `📊 *Bot Status*\n\n` +
      (config.dryRun ? `🧪 *MODE: DRY RUN*\n` : `🟢 *MODE: LIVE TRADING*\n`) +
      `⏱ Uptime: ${uptimeStr}\n` +
      `📈 Positions: ${openPos}/${config.risk.maxOpenPositions}\n` +
      `⏳ Pending approvals: ${pending}\n` +
      `⏭ Missed signals: ${this.missedSignals.length}\n\n` +
      `⚙️ *Config*\n` +
      `• Trade: ${config.trading.maxTradeSol} SOL\n` +
      `• Stop Loss: -${config.risk.stopLossPct}%\n` +
      `• RSI exit: >80\n` +
      `• Scan: tiap ${config.scanning.intervalSeconds / 60} menit\n` +
      `• Alert TTL: ${ttlMin} menit\n\n` +
      scannerHealth,
      { parse_mode: 'Markdown', ...keyboard }
    );
  }

  private async handlePositions(ctx: Context): Promise<void> {
    const mode = config.dryRun ? ' *(DRY RUN)*' : '';
    const summary = this.riskManager.getPositionSummary();
    const open = this.riskManager.getOpenPositions();

    const keyboard = open.length > 0
      ? Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'SHOW_POSITIONS')]])
      : Markup.inlineKeyboard([]);

    await ctx.reply(
      `📂 *Open Positions*${mode}\n\n${summary}`,
      { parse_mode: 'Markdown', ...keyboard }
    );
  }

  private async handleDryReport(ctx: Context): Promise<void> {
    if (!config.dryRun) {
      await ctx.reply(
        `ℹ️ *Mode: LIVE TRADING*\n\n` +
        `Dry report hanya tersedia di DRY_RUN=true.\n` +
        `Cek /positions untuk open positions live.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    const report = this.dryRunExecutor?.generateReport() ?? '📭 Dry run executor belum siap.';
    await ctx.reply(report, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });
  }

  private async handleMissed(ctx: Context): Promise<void> {
    if (!this.missedSignals.length) {
      await ctx.reply('✅ Tidak ada signal yang terlewat.', { parse_mode: 'Markdown' });
      return;
    }

    const recent = this.missedSignals.slice(-10).reverse();
    const ttlMin = Math.floor(APPROVAL_TTL_MS / 60000);

    let text = `⏭ *Missed Signals* (${this.missedSignals.length} total)\n`;
    text += `_Signal tidak direspons dalam ${ttlMin} menit_\n\n`;

    for (const s of recent) {
      const ago = Math.floor((Date.now() - s.expiredAt) / 60000);
      const emoji = ({ HIGH: '🔥', MEDIUM: '⚡', LOW: '💡' } as Record<string,string>)[s.confidence] ?? '';
      const label = s.reason === 'EXPIRED' ? '⏰ expired' : '❌ cancelled';
      text += `• *${s.symbol}* ${emoji} — ${label} ${ago}m lalu\n`;
      text += `  EMA${s.emaTouched} | RSI:${s.stochRsiK.toFixed(0)} | $${formatNumber(s.mcapUsd)}\n`;
      text += `  [Chart](https://dexscreener.com/solana/${s.tokenAddress})\n`;
    }

    text += `\n_Ketik /missed kapan saja untuk cek list ini_`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🗑 Clear List', 'CLEAR_MISSED')],
    ]);

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...keyboard,
    });
  }

  private async handleHelp(ctx: Context): Promise<void> {
    const ttlMin = Math.floor(APPROVAL_TTL_MS / 60000);
    const reminderMin = Math.floor(REMINDER_AT_MS / 60000);

    await ctx.reply(
      `❓ *Panduan Singkat*\n\n` +
      `*Alur bot:*\n` +
      `1. Bot scan otomatis tiap ${config.scanning.intervalSeconds / 60} menit\n` +
      `2. Alert dikirim ke sini saat ada signal\n` +
      `3. Kamu klik SIMULATE/APPROVE atau CANCEL\n` +
      `4. Kalau tidak ada respons dalam ${reminderMin} menit, bot kirim reminder\n` +
      `5. Alert expired setelah ${ttlMin} menit, tersimpan di Missed Signals\n` +
      `6. Bot monitor RSI tiap 2 menit, alert lagi saat RSI peak lebih dari 80\n` +
      `7. Exit manual di DexScreener saat dapat exit alert\n\n` +
      `*Entry signal (Obicle method):*\n` +
      `• Harga menyentuh EMA 25/50/100/200\n` +
      `• Stoch RSI di bawah 20 (bottoming)\n\n` +
      `*Exit alerts:*\n` +
      `📈 RSI Peak lebih dari 80 — pertimbangkan jual\n` +
      `📉 RSI drop setelah peak — momentum berbalik\n` +
      `🚨 Loss lebih dari -${config.risk.stopLossPct}% — stop loss\n\n` +
      `*Mode saat ini:* ${config.dryRun ? '🧪 DRY RUN — tidak ada tx nyata' : '🟢 LIVE TRADING'}`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── Approval flow ─────────────────────────────────────────────

  private async handleApproval(
    ctx: Context,
    approvalId: string,
    action: 'APPROVED' | 'REJECTED'
  ): Promise<void> {
    const request = this.pendingApprovals.get(approvalId);

    if (!request) {
      await ctx.answerCbQuery('❌ Request expired atau tidak ditemukan');
      return;
    }

    this.pendingApprovals.delete(approvalId);

    if (action === 'REJECTED') {
      request.status = 'REJECTED';
      this.riskManager.clearPendingApproval(request.signal.token.address);

      // Simpan ke missed (cancelled by user)
      this.addMissed(request.signal, 'CANCELLED');

      await ctx.answerCbQuery('❌ Trade dibatalkan');
      await ctx.editMessageText(
        `❌ *TRADE DIBATALKAN*\n\nToken: ${request.signal.token.symbol}\nDibatalkan oleh user`,
        { parse_mode: 'Markdown' }
      );
      logger.info(MODULE, `Trade REJECTED: ${request.signal.token.symbol}`);
      return;
    }

    // Check TTL
    if (Date.now() - request.timestamp > APPROVAL_TTL_MS) {
      request.status = 'EXPIRED';
      this.riskManager.clearPendingApproval(request.signal.token.address);
      await ctx.answerCbQuery('⏰ Request sudah expired');
      await ctx.editMessageText(
        `⏰ *REQUEST EXPIRED*\n\nToken: ${request.signal.token.symbol}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    request.status = 'APPROVED';
    await ctx.answerCbQuery('✅ Executing...');
    await ctx.editMessageText(
      `⏳ *EXECUTING TRADE...*\n\nToken: ${request.signal.token.symbol}\nMengirim via Jito Bundle...`,
      { parse_mode: 'Markdown' }
    );

    logger.info(MODULE, `Trade APPROVED: ${request.signal.token.symbol}`);

    if (this.onApproveCallback) {
      try {
        await this.onApproveCallback(request);
      } catch (err) {
        logger.error(MODULE, 'Execute callback error', err);
        await this.sendMessage(`❌ *EXECUTE ERROR*\n${request.signal.token.symbol}\n${String(err)}`);
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────

  onApprove(callback: ApprovalCallback): void {
    this.onApproveCallback = callback;
  }

  async sendSignalAlert(
    signal: SignalResult,
    tradeParams: TradeParams,
    quoteResult: QuoteResult,
    simulationResult: SimulationResult
  ): Promise<string> {
    const token = signal.token;
    const approvalId = `${Date.now()}_${token.address.slice(0, 8)}`;
    const isDryRun = config.dryRun;
    const ttlMin = Math.floor(APPROVAL_TTL_MS / 60000);
    const reminderMin = Math.floor(REMINDER_AT_MS / 60000);

    const request: ApprovalRequest = {
      id: approvalId,
      signal,
      tradeParams,
      quoteResult,
      simulationResult,
      timestamp: Date.now(),
      status: 'PENDING',
    };

    this.pendingApprovals.set(approvalId, request);

    // ── Reminder di setengah TTL ──────────────────────────────
    const reminderTimer = setTimeout(async () => {
      if (!this.pendingApprovals.has(approvalId)) return;
      logger.info(MODULE, `Reminder: ${token.symbol}`);
      await this.sendMessage(
        `⏰ *Reminder — Signal Belum Direspons*\n\n` +
        `🪙 *${token.symbol}* [${signal.confidence}]\n` +
        `EMA${signal.emaTouched} | RSI K:${signal.stochRsiK.toFixed(1)}\n` +
        `MCap: $${formatNumber(token.mcapUsd)}\n\n` +
        `Tersisa *${reminderMin} menit* sebelum expired.\n` +
        `Scroll ke atas untuk klik tombol.`
      );
    }, REMINDER_AT_MS);

    // ── Auto-expire saat TTL habis ────────────────────────────
    setTimeout(() => {
      clearTimeout(reminderTimer);
      if (!this.pendingApprovals.has(approvalId)) return;

      this.pendingApprovals.delete(approvalId);
      this.riskManager.clearPendingApproval(token.address);
      this.addMissed(signal, 'EXPIRED');

      logger.info(MODULE, `Signal expired (${ttlMin}min): ${token.symbol}`);
      this.sendMessage(
        `⏰ *Signal Expired* — ${token.symbol}\n` +
        `_Tidak direspons dalam ${ttlMin} menit._\n` +
        `Ketik /missed untuk lihat semua signal terlewat.`
      ).catch(() => {});
    }, APPROVAL_TTL_MS);

    // ── Build alert message ───────────────────────────────────
    const tokenAge    = Math.floor(token.ageSeconds / 3600);
    const tokenAgeMin = Math.floor((token.ageSeconds % 3600) / 60);
    const confEmoji   = ({ HIGH: '🔥', MEDIUM: '⚡', LOW: '💡' } as Record<string,string>)[signal.confidence];

    const message =
      (isDryRun ? `🧪 *[DRY RUN] SIGNAL ALERT*\n` : '') +
      `🎯 *SIGNAL - ${signal.confidence} CONFIDENCE* ${confEmoji}\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🪙 *${token.symbol}* (${token.name})\n` +
      `📊 MCap: $${formatNumber(token.mcapUsd)}\n` +
      `💧 Liquidity: $${formatNumber(token.liquidityUsd)}\n` +
      `🕐 Age: ${tokenAge}h ${tokenAgeMin}m\n` +
      `👥 Holders: ${token.holders.toLocaleString()}\n\n` +
      `📈 *Indicators*\n` +
      `• EMA${signal.emaTouched} Touch: ✅\n` +
      `• Stoch RSI K: ${signal.stochRsiK.toFixed(1)}\n` +
      `• Stoch RSI D: ${signal.stochRsiD.toFixed(1)}\n` +
      `• Status: ${signal.stochRsiBottoming ? '📉 BOTTOMING' : '➖ Normal'}\n\n` +
      `💰 *Trade Details*\n` +
      `• Amount: ${tradeParams.amountSol} SOL${isDryRun ? ' *(paper)*' : ''}\n` +
      `• Slippage: ${tradeParams.slippagePct}%\n` +
      `• Price Impact: ${quoteResult.priceImpactPct.toFixed(3)}%\n` +
      `• Est. Fee: ${simulationResult.estimatedFeeSOL.toFixed(6)} SOL\n\n` +
      `🔗 [DexScreener](https://dexscreener.com/solana/${token.address}) | [GMGN](https://gmgn.ai/sol/token/${token.address})\n\n` +
      (isDryRun
        ? `_Klik SIMULATE untuk paper trade (no real tx)_`
        : `⏰ Expires *${ttlMin} menit* | Reminder menit ke-${reminderMin}`);

    const approveLabel = isDryRun
      ? `🧪 SIMULATE (${tradeParams.amountSol} SOL paper)`
      : `✅ APPROVE BUY (${tradeParams.amountSol} SOL)`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(approveLabel, `APPROVE_${approvalId}`)],
      [Markup.button.callback('❌ CANCEL', `CANCEL_${approvalId}`)],
    ]);

    try {
      await this.bot.telegram.sendMessage(config.telegram.chatId, message, {
        parse_mode: 'Markdown',
        ...keyboard,
        link_preview_options: { is_disabled: true },
      } as Parameters<typeof this.bot.telegram.sendMessage>[2]);
      logger.info(MODULE, `Alert sent: ${token.symbol}`);
    } catch (err) {
      logger.error(MODULE, 'Failed to send alert', err);
    }

    return approvalId;
  }

  async sendTradeResult(
    symbol: string,
    success: boolean,
    details: { amountSol: number; txSignature?: string; bundleId?: string; error?: string }
  ): Promise<void> {
    const message = success
      ? `✅ *TRADE EXECUTED*\n\n` +
        `🪙 Token: ${symbol}\n` +
        `💰 Amount: ${details.amountSol} SOL\n` +
        (details.bundleId ? `📦 Bundle: ${details.bundleId.slice(0, 12)}...\n` : '') +
        `\n⚠️ *Monitor posisi — exit manual saat RSI puncak*`
      : `❌ *TRADE FAILED*\n\n` +
        `🪙 Token: ${symbol}\n` +
        `Reason: ${details.error ?? 'Unknown error'}`;

    await this.sendMessage(message);
  }

  async sendExitSignalAlert(signal: ExitSignal): Promise<void> {
    const { position, reason, pnlPct, stochRsiK, stochRsiD } = signal;
    const pnlStr = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;

    const headers: Record<string, string> = {
      RSI_PEAK:        '📈 *RSI PEAK — PERTIMBANGKAN JUAL*',
      RSI_DROP:        '📉 *RSI TURUN DARI PEAK — MOMENTUM BERBALIK*',
      STOP_LOSS_PCT:   '🚨 *STOP LOSS — JUAL SEGERA*',
      TAKE_PROFIT_PCT: '🎯 *TARGET PROFIT TERCAPAI*',
    };

    const urgency: Record<string, string> = {
      RSI_PEAK:        '💡 Exit sekarang atau tunggu konfirmasi RSI drop',
      RSI_DROP:        '⚠️ Momentum sudah berbalik — pertimbangkan exit',
      STOP_LOSS_PCT:   '🔴 *Loss melebihi threshold — exit manual segera*',
      TAKE_PROFIT_PCT: '💡 Tunggu RSI peak >80 untuk exit optimal',
    };

    const rsiInfo = stochRsiK !== undefined
      ? `• Stoch RSI K: ${stochRsiK.toFixed(1)} | D: ${(stochRsiD ?? 0).toFixed(1)}\n`
      : '';

    const holdMin = Math.floor((Date.now() - position.entryTimestamp) / 60000);

    const text =
      `${headers[reason] ?? reason}\n\n` +
      `🪙 *${position.symbol}*\n` +
      `💰 PnL: ${pnlStr}\n` +
      `📥 Entry: $${position.entryPriceUsd.toFixed(8)}\n` +
      `💵 Sekarang: $${signal.currentPrice.toFixed(8)}\n` +
      rsiInfo +
      `⏱ Hold: ${holdMin}m\n\n` +
      `${urgency[reason] ?? ''}\n\n` +
      `🔗 [DexScreener](https://dexscreener.com/solana/${position.tokenAddress})`;

    await this.sendMessage(text);
    logger.info(MODULE, `Exit alert: ${position.symbol} [${reason}] PnL:${pnlStr}`);
  }

  async sendMessage(text: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(config.telegram.chatId, text, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      logger.error(MODULE, 'sendMessage failed', err);
    }
  }

  async launch(): Promise<void> {
    try {
      await this.bot.telegram.setMyCommands([
        { command: 'start',      description: '🏠 Menu utama' },
        { command: 'status',     description: '📊 Status bot & scanner' },
        { command: 'positions',  description: '📂 Open positions' },
        { command: 'missed',     description: '⏭ Signal yang terlewat' },
        { command: 'dryreport',  description: '📝 Laporan paper trading' },
        { command: 'help',       description: '❓ Panduan singkat' },
      ]);
      await this.bot.launch({ allowedUpdates: ['message', 'callback_query'] });
      logger.info(MODULE, '🤖 Telegram bot launched');
    } catch (err) {
      logger.error(MODULE, 'Bot launch failed', err);
      throw err;
    }
  }

  stop(signal?: string): void {
    logger.info(MODULE, `Bot stopping (${signal ?? 'manual'})`);
    this.bot.stop(signal);
  }

  // ── Private helpers ───────────────────────────────────────────

  private addMissed(signal: SignalResult, reason: 'EXPIRED' | 'CANCELLED'): void {
    this.missedSignals.push({
      symbol: signal.token.symbol,
      tokenAddress: signal.token.address,
      confidence: signal.confidence,
      emaTouched: signal.emaTouched,
      stochRsiK: signal.stochRsiK,
      mcapUsd: signal.token.mcapUsd,
      expiredAt: Date.now(),
      reason,
    });
    // Jaga max 50 entry
    if (this.missedSignals.length > 50) this.missedSignals.shift();
  }
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
