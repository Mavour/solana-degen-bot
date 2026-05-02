// src/telegram/bot.ts
// Telegraf Telegram bot - Alert + Manual Approval Flow

import { Telegraf, Markup, Context } from 'telegraf';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ApprovalRequest, SignalResult, QuoteResult, SimulationResult, TradeParams } from '../utils/types';
import type { ExitSignal } from '../risk/manager';
import { RiskManager } from '../risk/manager';
import type { ScannerRouter } from '../scanner/index';
import type { DryRunExecutor } from '../execution/dryrun';

const MODULE = 'TELEGRAM';

// Approval TTL: 5 menit
const APPROVAL_TTL_MS = 5 * 60 * 1000;

type ApprovalCallback = (request: ApprovalRequest) => Promise<void>;

export class TelegramBot {
  private bot: Telegraf;
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private onApproveCallback: ApprovalCallback | null = null;
  private riskManager: RiskManager;
  // Injected after construction to avoid circular dep
  scannerRouter: ScannerRouter | null = null;
  dryRunExecutor: DryRunExecutor | null = null;

  constructor(riskManager: RiskManager) {
    this.bot = new Telegraf(config.telegram.botToken);
    this.riskManager = riskManager;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // /start command — show main menu keyboard
    this.bot.command('start', async (ctx) => {
      const modeLabel = config.dryRun ? '🧪 DRY RUN' : '🟢 LIVE';
      const keyboard = Markup.keyboard([
        ['📊 Status', '📂 Positions'],
        config.dryRun
          ? ['📝 Dry Report', '❓ Help']
          : ['❓ Help'],
        ['✖️ Tutup Menu'],
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

    // Handle keyboard button taps (reply keyboard)
    this.bot.hears('📊 Status', async (ctx) => ctx.reply('/status dipanggil...').then(() => {
      return this.handleStatus(ctx);
    }));
    this.bot.hears('📂 Positions', async (ctx) => this.handlePositions(ctx));
    this.bot.hears('📝 Dry Report', async (ctx) => this.handleDryReport(ctx));
    this.bot.hears('❓ Help', async (ctx) => this.handleHelp(ctx));

    // ✖️ Tutup Menu — sembunyikan reply keyboard
    this.bot.hears('✖️ Tutup Menu', async (ctx) => {
      await ctx.reply(
        'Menu disembunyikan. Ketik /start untuk tampilkan lagi.',
        Markup.removeKeyboard()
      );
    });

    // /status command
    this.bot.command('status', async (ctx) => this.handleStatus(ctx));

    // /positions command
    this.bot.command('positions', async (ctx) => this.handlePositions(ctx));

    // /dryreport command
    this.bot.command('dryreport', async (ctx) => this.handleDryReport(ctx));

    // /help command
    this.bot.command('help', async (ctx) => this.handleHelp(ctx));

    // Handle APPROVE button callback
    this.bot.action(/^APPROVE_(.+)$/, async (ctx) => {
      const approvalId = ctx.match[1];
      await this.handleApproval(ctx, approvalId, 'APPROVED');
    });

    // Handle CANCEL button callback
    this.bot.action(/^CANCEL_(.+)$/, async (ctx) => {
      const approvalId = ctx.match[1];
      await this.handleApproval(ctx, approvalId, 'REJECTED');
    });

    // Inline button callbacks for status/positions refresh
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

    // Error handler
    this.bot.catch((err, ctx) => {
      logger.error(MODULE, `Telegraf error for ${ctx.updateType}`, err);
    });
  }

  // ── Shared handler methods (used by both commands and keyboard buttons) ──

  private async handleStatus(ctx: Context): Promise<void> {
    const openPos = this.riskManager.getOpenPositions().length;
    const pending = this.pendingApprovals.size;
    const scannerHealth = this.scannerRouter?.getHealthStatus() ?? '📡 Scanner: initializing';
    const uptime = process.uptime();
    const uptimeStr = uptime < 3600
      ? `${Math.floor(uptime / 60)}m`
      : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Refresh', 'STATUS_REFRESH'),
        Markup.button.callback('📂 Positions', 'SHOW_POSITIONS'),
      ],
      config.dryRun
        ? [Markup.button.callback('📝 Dry Report', 'SHOW_DRYREPORT')]
        : [],
    ].filter(row => row.length > 0));

    await ctx.reply(
      `📊 *Bot Status*

` +
      (config.dryRun ? `🧪 *MODE: DRY RUN*
` : `🟢 *MODE: LIVE TRADING*
`) +
      `⏱ Uptime: ${uptimeStr}
` +
      `📈 Positions: ${openPos}/${config.risk.maxOpenPositions}
` +
      `⏳ Pending approvals: ${pending}

` +
      `⚙️ *Config*
` +
      `• Trade: ${config.trading.maxTradeSol} SOL
` +
      `• Stop Loss: -${config.risk.stopLossPct}%
` +
      `• RSI exit: >80
` +
      `• Scan: tiap ${config.scanning.intervalSeconds / 60} menit

` +
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
      `📂 *Open Positions*${mode}

${summary}`,
      { parse_mode: 'Markdown', ...keyboard }
    );
  }

  private async handleDryReport(ctx: Context): Promise<void> {
    if (!config.dryRun) {
      await ctx.reply(
        `ℹ️ *Mode: LIVE TRADING*

` +
        `Dry report hanya tersedia di DRY_RUN=true.
` +
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

  private async handleHelp(ctx: Context): Promise<void> {
    await ctx.reply(
      `❓ *Panduan Singkat*\n\n` +
      `*Alur bot:*\n` +
      `1. Bot scan otomatis tiap ${config.scanning.intervalSeconds / 60} menit\n` +
      `2. Alert dikirim ke sini saat ada signal\n` +
      `3. Kamu klik SIMULATE/APPROVE atau CANCEL\n` +
      `4. Bot monitor RSI tiap 2 menit\n` +
      `5. Alert lagi saat RSI peak (>80) → exit manual\n\n` +
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

    // Remove dari pending
    this.pendingApprovals.delete(approvalId);

    if (action === 'REJECTED') {
      request.status = 'REJECTED';
      this.riskManager.clearPendingApproval(request.signal.token.address);

      await ctx.answerCbQuery('❌ Trade dibatalkan');
      await ctx.editMessageText(
        `❌ *TRADE DIBATALKAN*\n\n` +
        `Token: ${request.signal.token.symbol}\n` +
        `Dibatalkan oleh user`,
        { parse_mode: 'Markdown' }
      );
      logger.info(MODULE, `Trade REJECTED by user: ${request.signal.token.symbol}`);
      return;
    }

    // Check TTL
    if (Date.now() - request.timestamp > APPROVAL_TTL_MS) {
      request.status = 'EXPIRED';
      this.riskManager.clearPendingApproval(request.signal.token.address);

      await ctx.answerCbQuery('⏰ Request sudah expired (5 menit)');
      await ctx.editMessageText(
        `⏰ *REQUEST EXPIRED*\n\nToken: ${request.signal.token.symbol}\nSignal sudah terlalu lama.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    request.status = 'APPROVED';
    await ctx.answerCbQuery('✅ Trade diapprove! Executing...');
    await ctx.editMessageText(
      `⏳ *EXECUTING TRADE...*\n\nToken: ${request.signal.token.symbol}\nMengirim via Jito Bundle...`,
      { parse_mode: 'Markdown' }
    );

    logger.info(MODULE, `Trade APPROVED by user: ${request.signal.token.symbol}`);

    // Trigger callback
    if (this.onApproveCallback) {
      try {
        await this.onApproveCallback(request);
      } catch (err) {
        logger.error(MODULE, 'Execute callback error', err);
        await this.sendMessage(`❌ *EXECUTE ERROR*\n${request.signal.token.symbol}\n${String(err)}`);
      }
    }
  }

  /**
   * Set callback untuk ketika user approve
   */
  onApprove(callback: ApprovalCallback): void {
    this.onApproveCallback = callback;
  }

  /**
   * Kirim signal alert dengan tombol APPROVE/CANCEL
   */
  async sendSignalAlert(
    signal: SignalResult,
    tradeParams: TradeParams,
    quoteResult: QuoteResult,
    simulationResult: SimulationResult
  ): Promise<string> {
    const token = signal.token;
    const approvalId = `${Date.now()}_${token.address.slice(0, 8)}`;

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

    // Auto-expire setelah 5 menit
    setTimeout(() => {
      if (this.pendingApprovals.has(approvalId)) {
        this.pendingApprovals.delete(approvalId);
        this.riskManager.clearPendingApproval(token.address);
        logger.info(MODULE, `Approval ${approvalId} auto-expired`);
      }
    }, APPROVAL_TTL_MS);

    const tokenAge = Math.floor(token.ageSeconds / 3600);
    const tokenAgeMin = Math.floor((token.ageSeconds % 3600) / 60);
    const confidenceEmoji = { HIGH: '🔥', MEDIUM: '⚡', LOW: '💡' }[signal.confidence];
    const isDryRun = config.dryRun;

    const message =
      (isDryRun ? `🧪 *[DRY RUN] SIGNAL ALERT*\n` : '') +
      `🎯 *SIGNAL - ${signal.confidence} CONFIDENCE* ${confidenceEmoji}\n` +
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
        ? `_Klik SIMULATE untuk catat paper trade (tidak ada tx nyata)_`
        : `⏰ *Request expires in 5 minutes*`);

    // Button text berbeda untuk dry run
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

      logger.info(MODULE, `Alert sent for ${token.symbol}`);
    } catch (err) {
      logger.error(MODULE, 'Failed to send alert', err);
    }

    return approvalId;
  }

  /**
   * Kirim notifikasi hasil trade
   */
  async sendTradeResult(
    symbol: string,
    success: boolean,
    details: {
      amountSol: number;
      txSignature?: string;
      bundleId?: string;
      error?: string;
    }
  ): Promise<void> {
    let message: string;

    if (success) {
      message =
        `✅ *TRADE EXECUTED*\n\n` +
        `🪙 Token: ${symbol}\n` +
        `💰 Amount: ${details.amountSol} SOL\n` +
        (details.txSignature ? `🔗 [View TX](https://solscan.io/tx/${details.txSignature})\n` : '') +
        (details.bundleId ? `📦 Bundle: ${details.bundleId.slice(0, 12)}...\n` : '') +
        `\n⚠️ *Monitor posisi dan set manual exit saat RSI puncak*`;
    } else {
      message =
        `❌ *TRADE FAILED*\n\n` +
        `🪙 Token: ${symbol}\n` +
        `💰 Amount: ${details.amountSol} SOL\n` +
        `Reason: ${details.error ?? 'Unknown error'}`;
    }

    await this.sendMessage(message);
  }

  /**
   * Unified exit signal alert — covers RSI_PEAK, RSI_DROP, STOP_LOSS_PCT, TAKE_PROFIT_PCT
   * Sesuai exit strategy Obicle: jual saat RSI puncak (>80)
   */
  async sendExitSignalAlert(signal: ExitSignal): Promise<void> {
    const { position, reason, pnlPct, stochRsiK, stochRsiD } = signal;
    const pnlStr = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;

    const headers: Record<string, string> = {
      RSI_PEAK:        '📈 *RSI PEAK — PERTIMBANGKAN JUAL*',
      RSI_DROP:        '📉 *RSI TURUN DARI PEAK — MOMENTUM BERBALIK*',
      STOP_LOSS_PCT:   '🚨 *STOP LOSS — JUAL SEGERA*',
      TAKE_PROFIT_PCT: '🎯 *TARGET PROFIT TERCAPAI*',
    };

    const urgencyNote: Record<string, string> = {
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
      `${urgencyNote[reason] ?? ''}\n\n` +
      `🔗 [DexScreener](https://dexscreener.com/solana/${position.tokenAddress})`;

    await this.sendMessage(text);
    logger.info(MODULE, `Exit alert: ${position.symbol} [${reason}] PnL:${pnlStr}`);
  }

  /**
   * Generic message sender
   */
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

  /**
   * Launch bot (polling mode)
   */
  async launch(): Promise<void> {
    try {
      // Register command menu — muncul di tombol hamburger (☰) Telegram
      const commands = [
        { command: 'start',      description: '🏠 Menu utama' },
        { command: 'status',     description: '📊 Status bot & scanner' },
        { command: 'positions',  description: '📂 Open positions' },
        { command: 'dryreport',  description: '📝 Laporan paper trading' },
        { command: 'help',       description: '❓ Panduan singkat' },
      ];
      await this.bot.telegram.setMyCommands(commands);

      await this.bot.launch({
        allowedUpdates: ['message', 'callback_query'],
      });
      logger.info(MODULE, '🤖 Telegram bot launched (polling mode)');
    } catch (err) {
      logger.error(MODULE, 'Bot launch failed', err);
      throw err;
    }
  }

  /**
   * Graceful shutdown
   */
  stop(signal?: string): void {
    logger.info(MODULE, `Bot stopping (${signal ?? 'manual'})`);
    this.bot.stop(signal);
  }
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
