// src/telegram/bot.ts
// Telegraf Telegram bot — Alert + Manual Approval + Missed Signals + Sell

import { Telegraf, Markup, Context } from 'telegraf';
import axios from 'axios';
import { config, applyRuntimeSettings } from '../config';
import { logger } from '../utils/logger';
import { ApprovalRequest, SignalResult, QuoteResult, SimulationResult, TradeParams, Position } from '../utils/types';
import type { ExitSignal } from '../risk/manager';
import { RiskManager } from '../risk/manager';
import type { ScannerRouter } from '../scanner/index';
import type { DryRunExecutor } from '../execution/dryrun';
import type { TradeExecutor } from '../execution/executor';

const MODULE = 'TELEGRAM';

// ── Markdown Escape Helpers ──────────────────────────────────
// Telegram MarkdownV2 requires escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
// We use basic 'Markdown' mode, but [text](url) syntax must be valid.
// Escape brackets and underscores in token names/addresses to avoid parse errors.

function escapeMarkdown(text: string): string {
  if (!text) return '';
  return text
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`')
    .replace(/>/g, '\\>');
}

// Escape ONLY inside link text, not URL itself
function safeSymbol(symbol: string): string {
  return escapeMarkdown(symbol);
}

/**
 * Fetch fresh price dari DexScreener untuk 1 token address.
 * Lebih cepat & reliable daripada full monitor cycle.
 */
async function fetchFreshPriceUSD(tokenAddress: string): Promise<number | null> {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/tokens/v1/solana/${tokenAddress}`,
      { timeout: 8000, headers: { 'Accept': 'application/json' } }
    );
    const pairs = Array.isArray(res.data) ? res.data : (res.data?.pairs ?? []);
    for (const p of pairs) {
      const price = parseFloat(p.priceUsd ?? p.price_usd ?? '0');
      if (price > 0) {
        logger.debug(MODULE, `fetchFreshPrice OK ${tokenAddress.slice(0, 8)}: $${price}`);
        return price;
      }
    }
    logger.warn(MODULE, `fetchFreshPrice no price for ${tokenAddress.slice(0, 8)}`);
  } catch (err: any) {
    const status = err.response?.status ?? 'no-resp';
    logger.warn(MODULE, `fetchFreshPrice failed ${tokenAddress.slice(0, 8)}: HTTP ${status} | ${err.message}`);
  }
  return null;
}

// TTL bisa dikonfigurasi — default 10 menit
const APPROVAL_TTL_MS = parseInt(process.env.APPROVAL_TTL_MINUTES ?? '10') * 60 * 1000;
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
  private tradeExecutor: TradeExecutor | null = null;
  private onManualScanCallback: (() => Promise<void>) | null = null;
  private editingSettings: Map<number, string> = new Map(); // chatId -> paramKey
  /** Tracking pesan alert terakhir per token — untuk hapus sebelum kirim baru */
  private sentAlertMessages: Map<string, number> = new Map();

  onManualScan(cb: () => Promise<void>): void {
    this.onManualScanCallback = cb;
  }

  setTradeExecutor(executor: TradeExecutor): void {
    this.tradeExecutor = executor;
  }

  constructor(riskManager: RiskManager) {
    this.bot = new Telegraf(config.telegram.botToken);
    this.riskManager = riskManager;
    this.setupHandlers();
  }

  // ── Handlers ─────────────────────────────────────────────────

  private setupHandlers(): void {

    // /start — welcome message only (no keyboard menu)
    this.bot.command('start', async (ctx) => {
      const modeLabel = config.dryRun ? '🧪 DRY RUN' : '🟢 LIVE';
      const scanMin = config.scanning.intervalSeconds / 60;

      await ctx.reply(
        `🤖 *VANGUARD-01 — Solana Degen Bot*\n\n` +
        `Mode: *${modeLabel}*\n` +
        `Scan: tiap *${scanMin} menit* | Monitor: tiap *${config.monitor.intervalSeconds / 60} menit*\n\n` +
        `*Command:*\n` +
        `/status — 📊 Status bot & scanner\n` +
        `/positions — 📂 Open positions (+ harga live)\n` +
        `/pnl — 📊 Total PnL summary\n` +
        `/settings — ⚙️ Ubah parameter trading\n` +
        `/scan — 🔍 Trigger scan manual\n` +
        `/missed — ⏭ Signal terlewat\n` +
        `/dryreport — 📝 Laporan paper trading\n` +
        `/help — ❓ Panduan lengkap\n\n` +
        `🛒 *Beli:* Klik tombol di alert signal\n` +
        `🔴 *Jual:* Klik SELL di /positions atau di alert exit\n\n` +
        `_Bot akan kirim alert signal & exit ke chat ini._`,
        { parse_mode: 'Markdown' }
      );
    });

    // (Keyboard menu dihapus — pakai command slash saja agar lebih simpel)

    // /ping
    this.bot.command('ping', async (ctx) => {
      await ctx.reply(`🏓 Pong! Bot hidup.\nUptime: ${Math.floor(process.uptime() / 60)}m`);
    });

    // Slash commands
    this.bot.command('status',    async (ctx) => this.handleStatus(ctx));
    this.bot.command('positions', async (ctx) => this.handlePositions(ctx));
    this.bot.command('pnl',       async (ctx) => this.handlePnL(ctx));
    this.bot.command('settings',  async (ctx) => this.handleSettings(ctx));
    this.bot.command('dryreport', async (ctx) => this.handleDryReport(ctx));
    this.bot.command('missed',    async (ctx) => this.handleMissed(ctx));
    this.bot.command('help',      async (ctx) => this.handleHelp(ctx));

    // /scan
    this.bot.command('scan', async (ctx) => {
      await ctx.reply('🔍 Memulai scan manual...');
      if (this.onManualScanCallback) {
        this.onManualScanCallback().catch(async (err) => {
          await this.sendMessage(`❌ Scan error: ${String(err)}`);
        });
      } else {
        await ctx.reply('⚠️ Scanner belum siap.');
      }
    });

    // APPROVE / CANCEL inline button callbacks
    this.bot.action(/^APPROVE_(.+)$/, async (ctx) => {
      await this.handleApproval(ctx, ctx.match[1], 'APPROVED');
    });
    this.bot.action(/^CANCEL_(.+)$/, async (ctx) => {
      await this.handleApproval(ctx, ctx.match[1], 'REJECTED');
    });
    this.bot.action(/^REFRESH_APPROVAL_(.+)$/, async (ctx) => {
      await this.handleRefreshApproval(ctx, ctx.match[1]);
    });

    // SELL / CONFIRM SELL / CANCEL SELL callbacks
    this.bot.action(/^SELL_(.+)$/, async (ctx) => {
      await this.handleSellCallback(ctx, ctx.match[1]);
    });
    this.bot.action(/^CONFIRM_SELL_(.+)$/, async (ctx) => {
      await this.handleConfirmSell(ctx, ctx.match[1]);
    });
    this.bot.action('CANCEL_SELL', async (ctx) => {
      await ctx.answerCbQuery('❌ Dibatalkan');
      await ctx.editMessageText('❌ *Penjualan dibatalkan.*').catch(() => {});
    });
    this.bot.action('DISMISS_EXIT', async (ctx) => {
      await ctx.answerCbQuery('Dismissed');
      await ctx.editMessageText('⚠️ Exit alert di-dismiss. Ketik /sell <SYMBOL> kapan saja untuk jual manual.').catch(() => {});
    });

    // Refresh exit alert price
    this.bot.action(/^REFRESH_EXIT_(.+)$/, async (ctx) => {
      await this.handleRefreshExit(ctx, ctx.match[1]);
    });

    // Settings callbacks
    this.bot.action(/^SET_(.+)$/, async (ctx) => {
      await this.handleSettingSelect(ctx, ctx.match[1]);
    });
    this.bot.action('TOGGLE_dryRun', async (ctx) => {
      await this.handleToggleDryRun(ctx);
    });

    // Catch-all text untuk settings input
    this.bot.on('text', async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId && this.editingSettings.has(chatId)) {
        await this.handleSettingValue(ctx);
      }
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
      await ctx.deleteMessage().catch(() => {});
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

  // ── Sell flow: refresh price → confirm → execute ────────────

  /**
   * Step 1: Fetch fresh price, show confirmation dengan PnL terupdate
   */
  private async showSellConfirmation(ctx: Context, position: Position): Promise<void> {
    const safeSym = safeSymbol(position.symbol);
    const msg = await ctx.reply(
      `🔄 *Refresh harga untuk ${safeSym}...*\n\n` +
      `Mengambil harga terbaru dari market...`,
      { parse_mode: 'Markdown' }
    );

    // Fetch fresh price
    const freshPrice = await fetchFreshPriceUSD(position.tokenAddress);
    const currentPrice = freshPrice ?? this.riskManager.getLastKnownPrice(position.tokenAddress) ?? position.entryPriceUsd;

    const pnlPct = position.entryPriceUsd > 0
      ? ((currentPrice - position.entryPriceUsd) / position.entryPriceUsd) * 100
      : 0;
    const pnlEmoji = pnlPct >= 0 ? '📈' : '📉';
    const pnlStr = `${pnlEmoji} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;

    const ageMin = Math.floor((Date.now() - position.entryTimestamp) / 60000);

    const text =
      `⚠️ *KONFIRMASI JUAL — Harga Terupdate*\n\n` +
      `🪙 *${safeSym}*\n` +
      `📥 Entry: $${position.entryPriceUsd.toFixed(8)}\n` +
      `💵 *Sekarang: $${currentPrice.toFixed(8)}*\n` +
      `💰 PnL: ${pnlStr}\n` +
      `⏱ Hold: ${ageMin}m\n` +
      `💼 Size: ${position.amountSol} SOL\n\n` +
      (freshPrice ? `✅ Harga fresh dari market\n` : `⚠️ Harga dari cache terakhir\n`) +
      `Klik CONFIRM SELL untuk eksekusi:`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`🔴 CONFIRM SELL ${safeSym}`, `CONFIRM_SELL_${position.id}`)],
      [Markup.button.callback('❌ Batal', 'CANCEL_SELL')],
    ]);

    // Hapus pesan "refreshing" dan kirim konfirmasi
    await ctx.telegram.deleteMessage(ctx.chat!.id, msg.message_id).catch(() => {});
    try {
      await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    } catch (e: any) {
      // Fallback: kalau Markdown parse error, kirim plain text biar tombol tetap muncul
      if (e?.response?.error_code === 400) {
        await ctx.reply(text, keyboard);
      } else {
        throw e;
      }
    }
  }

  /**
   * Step 2: User klik SELL NOW (dari exit alert atau /positions)
   * → Trigger showSellConfirmation
   */
  private async handleSellCallback(ctx: Context, positionId: string): Promise<void> {
    const position = this.riskManager.getOpenPositions().find(p => p.id === positionId);
    if (!position) {
      await ctx.answerCbQuery('❌ Position sudah ditutup atau tidak ditemukan');
      return;
    }

    await ctx.answerCbQuery('🔄 Refreshing price...');
    await this.showSellConfirmation(ctx, position);
  }

  /**
   * Step 3: User klik CONFIRM SELL → Eksekusi jual
   */
  private async handleConfirmSell(ctx: Context, positionId: string): Promise<void> {
    const position = this.riskManager.getOpenPositions().find(p => p.id === positionId);
    if (!position) {
      await ctx.answerCbQuery('❌ Position sudah ditutup atau tidak ditemukan');
      return;
    }

    await ctx.answerCbQuery('⏳ Selling...');
    await ctx.editMessageText(
      `⏳ *SELLING ${safeSymbol(position.symbol)}...*\n\n` +
      `Mengirim Jito sell bundle...`,
      { parse_mode: 'Markdown' }
    );

    if (!this.tradeExecutor) {
      await ctx.editMessageText('❌ Trade executor belum siap.').catch(() => {});
      return;
    }

    try {
      await this.tradeExecutor.executeSell(position);
    } catch (err) {
      // executeSell sudah handle error internal dan kirim sendSellResult.
      // Kalau sampai di sini = unexpected error, cukup log.
      logger.error(MODULE, `Unexpected sell callback error for ${position.symbol}`, err);
    }
  }

  /**
   * Refresh exit alert price — dipanggil saat klik 🔄 Refresh di exit alert
   */
  private async handleRefreshExit(ctx: Context, positionId: string): Promise<void> {
    const position = this.riskManager.getOpenPositions().find(p => p.id === positionId);
    if (!position) {
      await ctx.answerCbQuery('❌ Position sudah ditutup');
      return;
    }

    await ctx.answerCbQuery('🔄 Refreshing...');

    // Fetch fresh price
    const freshPrice = await fetchFreshPriceUSD(position.tokenAddress);
    const currentPrice = freshPrice ?? this.riskManager.getLastKnownPrice(position.tokenAddress) ?? position.entryPriceUsd;

    const pnlPct = position.entryPriceUsd > 0
      ? ((currentPrice - position.entryPriceUsd) / position.entryPriceUsd) * 100
      : 0;
    const pnlStr = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
    const pnlEmoji = pnlPct >= 0 ? '📈' : '📉';
    const safeSym = safeSymbol(position.symbol);
    const holdMin = Math.floor((Date.now() - position.entryTimestamp) / 60000);

    // Rebuild text sama seperti sendExitSignalAlert tapi dengan harga baru
    const headers: Record<string, string> = {
      RSI_PEAK:        '📈 *RSI PEAK — PERTIMBANGKAN JUAL*',
      RSI_DROP:        '📉 *RSI TURUN DARI PEAK — MOMENTUM BERBALIK*',
      STOP_LOSS_PCT:   '🚨 *STOP LOSS — JUAL SEGERA*',
      TAKE_PROFIT_PCT: '🎯 *TARGET PROFIT TERCAPAI*',
      TRAILING_STOP:   '🛡 *TRAILING STOP — PROFIT DIKUNCI*',
      PARTIAL_PROFIT:  '💰 *PARTIAL PROFIT — JUAL SEBAGIAN*',
      TIME_EXIT:       '⏰ *TIME EXIT — POSISI STAGNAN*',
    };

    const urgency: Record<string, string> = {
      RSI_PEAK:        '💡 Exit sekarang atau tunggu konfirmasi RSI drop',
      RSI_DROP:        '⚠️ Momentum sudah berbalik — pertimbangkan exit',
      STOP_LOSS_PCT:   '🔴 *Loss melebihi threshold — exit manual segera*',
      TAKE_PROFIT_PCT: '💡 Tunggu RSI peak >80 untuk exit optimal',
      TRAILING_STOP:   '🛡 Profit sudah turun dari peak — jual sebelum loss!',
      PARTIAL_PROFIT:  '💰 Lock profit 50% dulu, sisanya biarkan jalan',
      TIME_EXIT:       '⏰ Posisi terlalu lama stagnan — cut loss & cari lain',
    };

    const text =
      `${headers[pnlPct <= -config.risk.stopLossPct ? 'STOP_LOSS_PCT' : pnlPct >= config.risk.takeProfitPct ? 'TAKE_PROFIT_PCT' : 'RSI_PEAK'] ?? '📊 *EXIT ALERT*'}\n\n` +
      `🪙 *${safeSym}*\n` +
      `💰 PnL: ${pnlEmoji} ${pnlStr}\n` +
      `📥 Entry: $${position.entryPriceUsd.toFixed(8)}\n` +
      `💵 *Sekarang: $${currentPrice.toFixed(8)}*\n` +
      `⏱ Hold: ${holdMin}m\n\n` +
      `${freshPrice ? '_✅ Harga di-refresh_' : '_⚠️ Harga dari cache_'}\n\n` +
      `${urgency[pnlPct <= -config.risk.stopLossPct ? 'STOP_LOSS_PCT' : 'RSI_PEAK'] ?? ''}\n\n` +
      `🔗 [DexScreener](https://dexscreener.com/solana/${position.tokenAddress})`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`🔴 SELL NOW ${safeSym}`, `SELL_${position.id}`)],
      [Markup.button.callback('🔄 Refresh Price', `REFRESH_EXIT_${position.id}`)],
      [Markup.button.callback('✖️ DISMISS', 'DISMISS_EXIT')],
    ]);

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...keyboard,
      link_preview_options: { is_disabled: true },
    }).catch(() => {});
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
      `• Trade: ${config.trading.maxTradeSol} SOL (size by confidence)\n` +
      `• MCap: $${(config.trading.minMcapUsd/1000).toFixed(0)}K – $${(config.trading.maxMcapUsd/1000000).toFixed(0)}M\n` +
      `• Stop Loss: -${config.risk.stopLossPct}% | Trailing: ON\n` +
      `• Partial TP: ON | Time Exit: ON\n` +
      `• RSI exit: >80\n` +
      `• Scan: tiap ${config.scanning.intervalSeconds / 60} menit\n` +
      `• Alert TTL: ${ttlMin} menit\n\n` +
      scannerHealth,
      { parse_mode: 'Markdown', ...keyboard }
    );
  }

  private async handlePositions(ctx: Context): Promise<void> {
    const mode = config.dryRun ? ' *(DRY RUN)*' : '';
    const open = this.riskManager.getOpenPositions();

    // Fetch fresh prices — parallel untuk semua open positions
    let tempMsg: any;
    const freshPrices = new Map<string, number>();
    let fetchedCount = 0;
    let failedCount = 0;
    if (open.length > 0) {
      tempMsg = await ctx.reply('🔄 *Refresh harga...*', { parse_mode: 'Markdown' });

      // Parallel fetch — jauh lebih cepat dari sequential
      const pricePromises = open.map(async (pos) => {
        const price = await fetchFreshPriceUSD(pos.tokenAddress);
        return { addr: pos.tokenAddress, price };
      });

      const results = await Promise.all(pricePromises);
      for (const { addr, price } of results) {
        if (price && price > 0) {
          freshPrices.set(addr, price);
          fetchedCount++;
        } else {
          failedCount++;
        }
      }

      if (freshPrices.size > 0) {
        this.riskManager.updatePrices(freshPrices);
      }
      // Hapus pesan "refreshing"
      if (tempMsg?.message_id) {
        await ctx.telegram.deleteMessage(ctx.chat!.id, tempMsg.message_id).catch(() => {});
      }
    }

    const summary = this.riskManager.getPositionSummary();

    // Indikator harga fresh vs cache
    const priceIndicator = open.length > 0
      ? (fetchedCount === open.length
          ? '\n_✅ Harga di-refresh dari DexScreener_'
          : `\n_⚠️ ${fetchedCount}/${open.length} harga di-refresh, ${failedCount} dari cache_`)
      : '';

    // Build keyboard: SELL button for each position + Refresh
    const buttons: any[] = [];
    for (const pos of open.slice(0, 8)) { // max 8 sell buttons (Telegram limit)
      buttons.push([Markup.button.callback(`🔴 SELL ${safeSymbol(pos.symbol)}`, `SELL_${pos.id}`)]);
    }
    buttons.push([Markup.button.callback('🔄 Refresh', 'SHOW_POSITIONS')]);
    const keyboard = Markup.inlineKeyboard(buttons);

    await ctx.reply(
      `📂 *Open Positions*${mode}\n\n${summary}${priceIndicator}`,
      { parse_mode: 'Markdown', ...keyboard }
    );
  }

  private async handlePnL(ctx: Context): Promise<void> {
    const allPositions = Array.from(this.riskManager['positions'].values());
    if (!allPositions.length) {
      await ctx.reply('📭 Belum ada trading history.', { parse_mode: 'Markdown' });
      return;
    }

    const closed = allPositions.filter((p: Position) => p.status === 'CLOSED');
    const open = this.riskManager.getOpenPositions();

    // Calculate totals
    const totalTrades = allPositions.length;
    const winCount = closed.filter((p: Position) => (p.pnlPct ?? 0) > 0).length;
    const lossCount = closed.filter((p: Position) => (p.pnlPct ?? 0) <= 0).length;
    const avgPnl = closed.length
      ? closed.reduce((a: number, p: Position) => a + (p.pnlPct ?? 0), 0) / closed.length
      : 0;
    const totalSol = allPositions.reduce((a: number, p: Position) => a + p.amountSol, 0);

    // Open PnL (live)
    let openPnlTotal = 0;
    let openPnlStr = '';
    if (open.length) {
      for (const pos of open) {
        const currentPrice = this.riskManager.getLastKnownPrice(pos.tokenAddress) ?? pos.entryPriceUsd;
        if (pos.entryPriceUsd > 0) {
          const pnl = ((currentPrice - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
          openPnlTotal += pnl;
        }
      }
      const avgOpen = openPnlTotal / open.length;
      openPnlStr = `🟢 Open: ${open.length} | Avg: ${avgOpen >= 0 ? '+' : ''}${avgOpen.toFixed(2)}%\n`;
    }

    const text =
      `📊 *PnL Summary*\n\n` +
      `💰 Total Trades: *${totalTrades}* (${totalSol.toFixed(1)} SOL)\n` +
      `📁 Closed: *${closed.length}* | 🟢 Open: *${open.length}*\n` +
      `✅ Wins: *${winCount}* | ❌ Losses: *${lossCount}*\n` +
      `📈 Avg PnL: *${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%*\n\n` +
      (openPnlStr ? `${openPnlStr}\n` : '') +
      (closed.length
        ? `*Last 5 closed:*\n` +
          closed.slice(-5).reverse().map((p: Position) =>
            `• *${safeSymbol(p.symbol)}* ${(p.pnlPct ?? 0) >= 0 ? '📈' : '📉'} ${(p.pnlPct ?? 0) >= 0 ? '+' : ''}${(p.pnlPct ?? 0).toFixed(2)}%`
          ).join('\n')
        : '');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  }

  private async handleSignals(ctx: Context): Promise<void> {
    const pending = Array.from(this.pendingApprovals.values());
    if (!pending.length) {
      await ctx.reply('📭 Tidak ada signal yang menunggu respons.', { parse_mode: 'Markdown' });
      return;
    }

    let text = `📡 *Pending Signals* (${pending.length})\n\n`;
    for (const req of pending) {
      const token = req.signal.token;
      const ageMin = Math.floor((Date.now() - req.timestamp) / 60000);
      const ttlMin = Math.floor(APPROVAL_TTL_MS / 60000);
      const remainMin = ttlMin - ageMin;
      const confEmoji = ({ HIGH: '🔥', MEDIUM: '⚡', LOW: '💡' } as Record<string,string>)[req.signal.confidence];

      text += `${confEmoji} *${safeSymbol(token.symbol)}* | ${req.signal.confidence}\n`;
      text += `📊 $${formatNumber(token.mcapUsd)} | EMA${req.signal.emaTouched} | RSI K:${req.signal.stochRsiK.toFixed(1)}\n`;
      text += `⏰ ${remainMin}min remaining | ${req.tradeParams.amountSol} SOL\n`;
      text += `🔗 [DexScreener](https://dexscreener.com/solana/${token.address}) | [GMGN](https://gmgn.ai/sol/token/${token.address})\n\n`;
    }

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });
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
    try {
      await ctx.reply(report, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      // Markdown parse error — fallback to plain text
      logger.warn(MODULE, 'Markdown parse error in dry report, sending plain text');
      await ctx.reply(report, {
        link_preview_options: { is_disabled: true },
      });
    }
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
      `5. Alert expired setelah ${ttlMin} menit — message asli di-edit jadi ⏰ EXPIRED\n` +
      `6. Bot monitor RSI tiap 2 menit, alert lagi saat RSI peak lebih dari 80\n` +
      `7. Klik SELL NOW di alert exit, atau di /positions untuk jual manual\n\n` +
      `*Entry signal (Obicle v2):*\n` +
      `• Harga menyentuh EMA di UPTREND\n` +
      `• Stoch RSI di bawah 20 (bottoming)\n` +
      `• Volume confirmation & trend filter\n` +
      `• LOW confidence signals skipped\n\n` +
      `*Exit alerts:*\n` +
      `🚨 Stop loss -${config.risk.stopLossPct}% (tight)\n` +
      `🛡 Trailing stop setelah +15%\n` +
      `💰 Partial profit di +30% (jual 50%)\n` +
      `⏰ Time exit setelah 4 jam stagnan\n` +
      `📈 RSI Peak lebih dari 80\n\n` +
      `*Mode saat ini:* ${config.dryRun ? '🧪 DRY RUN — tidak ada tx nyata' : '🟢 LIVE TRADING'}`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── Settings flow ───────────────────────────────────────────

  private async handleSettings(ctx: Context): Promise<void> {
    const mode = config.dryRun ? '🧪 DRY RUN' : '🟢 LIVE';
    const scanMin = config.scanning.intervalSeconds / 60;
    const monMin = config.monitor.intervalSeconds / 60;

    const volK = (config.trading.minVolumeUsd24h / 1000).toFixed(0);

    const text =
      `⚙️ *Settings — ${mode}*\n\n` +
      `💰 *Trade*\n` +
      `• Trade Size: *${config.trading.maxTradeSol} SOL*\n` +
      `• Slippage: *${config.trading.slippageMinPct} – ${config.trading.slippageMaxPct}%*\n` +
      `• Max Impact: *${config.trading.maxPriceImpactPct}%*\n` +
      `• Min Volume: *$${volK}K* (24h)\n\n` +
      `🛡 *Risk*\n` +
      `• Stop Loss: *-${config.risk.stopLossPct}%*\n` +
      `• Take Profit: *+${config.risk.takeProfitPct}%*\n\n` +
      `⏱ *Intervals*\n` +
      `• Scan: *${scanMin} menit*\n` +
      `• Monitor: *${monMin} menit*\n\n` +
      `_Klik parameter di bawah untuk ubah:_`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`💰 Trade Size (${config.trading.maxTradeSol} SOL)`, 'SET_maxTradeSol')],
      [Markup.button.callback(`📊 Min Volume ($${volK}K)`, 'SET_minVolumeUsd24h')],
      [Markup.button.callback(`🛡 Stop Loss (${config.risk.stopLossPct}%)`, 'SET_stopLossPct')],
      [Markup.button.callback(`🎯 Take Profit (${config.risk.takeProfitPct}%)`, 'SET_takeProfitPct')],
      [Markup.button.callback(`⚡ Slippage Min (${config.trading.slippageMinPct}%)`, 'SET_slippageMinPct')],
      [Markup.button.callback(`⚡ Slippage Max (${config.trading.slippageMaxPct}%)`, 'SET_slippageMaxPct')],
      [Markup.button.callback(`📊 Max Impact (${config.trading.maxPriceImpactPct}%)`, 'SET_maxPriceImpactPct')],
      [Markup.button.callback(`🔍 Scan Interval (${scanMin}m)`, 'SET_scanIntervalSeconds')],
      [Markup.button.callback(`👁 Monitor Interval (${monMin}m)`, 'SET_monitorIntervalSeconds')],
      [Markup.button.callback(`🧪 Toggle DRY_RUN (${config.dryRun ? 'ON' : 'OFF'})`, 'TOGGLE_dryRun')],
    ]);

    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }

  private async handleSettingSelect(ctx: Context, paramKey: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    this.editingSettings.set(chatId, paramKey);

    const labels: Record<string, string> = {
      maxTradeSol: 'Trade Size (SOL)',
      minVolumeUsd24h: 'Min Volume 24h (USD)',
      stopLossPct: 'Stop Loss (%)',
      takeProfitPct: 'Take Profit (%)',
      slippageMinPct: 'Slippage Min (%)',
      slippageMaxPct: 'Slippage Max (%)',
      maxPriceImpactPct: 'Max Price Impact (%)',
      scanIntervalSeconds: 'Scan Interval (detik)',
      monitorIntervalSeconds: 'Monitor Interval (detik)',
    };

    await ctx.answerCbQuery();
    await ctx.reply(
      `✏️ *Ubah ${labels[paramKey] ?? paramKey}*\n\n` +
      `Kirim nilai baru sebagai angka.\n` +
      `Contoh: \`0.2\`, \`15\`, \`180\`\n\n` +
      `_Ketik /settings untuk batal._`,
      { parse_mode: 'Markdown' }
    );
  }

  private async handleSettingValue(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const paramKey = this.editingSettings.get(chatId);
    if (!paramKey) return; // bukan mode edit

    const text = (ctx.message as any)?.text ?? '';
    const num = parseFloat(text);

    if (isNaN(num) || num < 0) {
      await ctx.reply('❌ Nilai tidak valid. Kirim angka positif.', { parse_mode: 'Markdown' });
      return;
    }

    // Build partial setting
    const partial: Record<string, number> = { [paramKey]: num };

    // Kalau scan/monitor interval, convert dari menit ke detik kalau user kirim < 60
    // (asumsi: kalau < 60, user mungkin maksud menit)
    if ((paramKey === 'scanIntervalSeconds' || paramKey === 'monitorIntervalSeconds') && num < 60) {
      partial[paramKey] = num * 60;
      await ctx.reply(`ℹ️ Dianggap *${num} menit* = ${partial[paramKey]} detik.`);
    }

    const needsRestart = applyRuntimeSettings(partial);
    this.editingSettings.delete(chatId);

    let msg = `✅ *${paramKey}* diupdate ke *${partial[paramKey]}*`;
    if (needsRestart.length) {
      msg += `\n\n⚠️ *Restart diperlukan* untuk:\n`;
      msg += needsRestart.map(s => `• ${s}`).join('\n');
      msg += `\n\n_Ketik \`pm2 restart solana-degen-bot\` di VPS, atau tunggu restart otomatis._`;
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  }

  private async handleToggleDryRun(ctx: Context): Promise<void> {
    const newValue = !config.dryRun;
    const needsRestart = applyRuntimeSettings({ dryRun: newValue });

    await ctx.answerCbQuery(`DRY_RUN = ${newValue ? 'ON' : 'OFF'}`);
    await ctx.editMessageText(
      `🧪 *DRY_RUN diubah ke ${newValue ? 'ON ✅' : 'OFF 🔴'}*\n\n` +
      `⚠️ *Restart diperlukan* agar perubahan berlaku.\n` +
      `_Ketik \`pm2 restart solana-degen-bot\` di VPS._`,
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
      this.sentAlertMessages.delete(request.signal.token.address);

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
      this.sentAlertMessages.delete(request.signal.token.address);
      await ctx.answerCbQuery('⏰ Request sudah expired');
      await ctx.editMessageText(
        `⏰ *REQUEST EXPIRED*\n\nToken: ${request.signal.token.symbol}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Re-check risk guard — posisi mungkin sudah terbuka dari alert lain
    const riskCheck = this.riskManager.canTrade(request.signal.token.address);
    if (!riskCheck.allowed) {
      this.sentAlertMessages.delete(request.signal.token.address);
      await ctx.answerCbQuery('❌ Trade dibatalkan');
      await ctx.editMessageText(
        `❌ *TRADE DIBATALKAN*\n\nToken: ${request.signal.token.symbol}\nAlasan: ${riskCheck.reason}`,
        { parse_mode: 'Markdown' }
      );
      logger.info(MODULE, `Trade APPROVED blocked: ${request.signal.token.symbol} — ${riskCheck.reason}`);
      return;
    }

    request.status = 'APPROVED';
    this.sentAlertMessages.delete(request.signal.token.address);
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

  private async handleRefreshApproval(ctx: Context, approvalId: string): Promise<void> {
    const request = this.pendingApprovals.get(approvalId);
    if (!request) {
      await ctx.answerCbQuery('❌ Request expired');
      return;
    }

    await ctx.answerCbQuery('🔄 Refreshing price...');

    const token = request.signal.token;
    const freshPrice = await fetchFreshPriceUSD(token.address);

    if (!freshPrice || freshPrice <= 0) {
      await ctx.answerCbQuery('⚠️ Gagal refresh harga');
      return;
    }

    // Update token price in request
    request.signal.token.priceUsd = freshPrice;

    const isDryRun = config.dryRun;
    const ttlMin = Math.floor(APPROVAL_TTL_MS / 60000);
    const ageMin = Math.floor((Date.now() - request.timestamp) / 60000);
    const remainMin = ttlMin - ageMin;
    const confEmoji = ({ HIGH: '🔥', MEDIUM: '⚡', LOW: '💡' } as Record<string,string>)[request.signal.confidence];
    const safeSymbolStr = safeSymbol(token.symbol);

    const tokenAgeH = Math.floor(token.ageSeconds / 3600);
    const tokenAgeM = Math.floor((token.ageSeconds % 3600) / 60);

    const updatedMessage =
      (isDryRun ? `🧪 *DRY RUN* ` : '') +
      `🎯 *${request.signal.confidence}* ${confEmoji} | *${safeSymbolStr}*\n` +
      `📊 $${formatNumber(token.mcapUsd)} | 💧 $${formatNumber(token.liquidityUsd)} | 🕐 ${tokenAgeH}h${tokenAgeM}m\n` +
      `💵 *Price refreshed: $${freshPrice.toFixed(8)}*\n\n` +
      `📈 EMA${request.signal.emaTouched} Touch ✅ | RSI K:${request.signal.stochRsiK.toFixed(1)} D:${request.signal.stochRsiD.toFixed(1)} | ${request.signal.stochRsiBottoming ? '📉 BOTTOMING' : '➖ Normal'}\n\n` +
      `💰 ${request.tradeParams.amountSol} SOL${isDryRun ? ' paper' : ''} | Slippage ${request.tradeParams.slippagePct}% | Impact ${request.quoteResult.priceImpactPct.toFixed(2)}%\n` +
      `🔗 [DexScreener](https://dexscreener.com/solana/${token.address}) | [GMGN](https://gmgn.ai/sol/token/${token.address})\n\n` +
      (isDryRun
        ? `_⏰ ${remainMin}min remaining — Klik SIMULATE atau SKIP_`
        : `⏰ ${remainMin}min remaining — Klik APPROVE atau CANCEL`);

    const approveLabel = isDryRun
      ? `🧪 SIMULATE (${request.tradeParams.amountSol} SOL paper)`
      : `✅ APPROVE BUY (${request.tradeParams.amountSol} SOL)`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(approveLabel, `APPROVE_${approvalId}`)],
      [Markup.button.callback('❌ CANCEL', `CANCEL_${approvalId}`)],
      [Markup.button.callback('🔄 Refresh Price', `REFRESH_APPROVAL_${approvalId}`)],
    ]);

    try {
      await ctx.editMessageText(updatedMessage, {
        parse_mode: 'Markdown',
        ...keyboard,
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      logger.error(MODULE, 'Failed to refresh approval message', err);
    }
  }

  // ── Public API ────────────────────────────────────────────────

  onApprove(callback: ApprovalCallback): void {
    this.onApproveCallback = callback;
  }

  /**
   * Cek apakah token ini masih punya approval request yang pending.
   * Dipakai orchestrator untuk mencegah spam alert berulang.
   */
  hasPendingApprovalForToken(tokenAddress: string): boolean {
    for (const req of this.pendingApprovals.values()) {
      if (req.signal.token.address === tokenAddress && req.status === 'PENDING') {
        return true;
      }
    }
    return false;
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

    // ── Build alert message & keyboard (sebelum timer) ──────
    const tokenAge    = Math.floor(token.ageSeconds / 3600);
    const tokenAgeMin = Math.floor((token.ageSeconds % 3600) / 60);
    const confEmoji   = ({ HIGH: '🔥', MEDIUM: '⚡', LOW: '💡' } as Record<string,string>)[signal.confidence];
    const safeSymbolStr = safeSymbol(token.symbol);

    // Balance warning untuk LIVE mode
    const balanceWarning = !isDryRun
      ? `⚠️ Pastikan wallet punya ≥${tradeParams.amountSol + 0.001} SOL (trade + fee)\n`
      : '';

    // Compact signal format
    const message =
      (isDryRun ? `🧪 *DRY RUN* ` : '') +
      `🎯 *${signal.confidence}* ${confEmoji} | *${safeSymbolStr}*\n` +
      `📊 $${formatNumber(token.mcapUsd)} | 💧 $${formatNumber(token.liquidityUsd)} | 🕐 ${tokenAge}h${tokenAgeMin}m | _just now_\n\n` +
      `📈 EMA${signal.emaTouched} Touch ✅ | RSI K:${signal.stochRsiK.toFixed(1)} D:${signal.stochRsiD.toFixed(1)} | ${signal.stochRsiBottoming ? '📉 BOTTOMING' : '➖ Normal'}\n\n` +
      `💰 ${tradeParams.amountSol} SOL${isDryRun ? ' paper' : ''} | Slippage ${tradeParams.slippagePct}% | Impact ${quoteResult.priceImpactPct.toFixed(2)}%\n` +
      `${balanceWarning}` +
      `🔗 [DexScreener](https://dexscreener.com/solana/${token.address}) | [GMGN](https://gmgn.ai/sol/token/${token.address})\n\n` +
      (isDryRun
        ? `_⏰ ${ttlMin}min — Klik SIMULATE atau SKIP_`
        : `⏰ ${ttlMin}min — Klik APPROVE atau CANCEL`);

    const approveLabel = isDryRun
      ? `🧪 SIMULATE (${tradeParams.amountSol} SOL paper)`
      : `✅ APPROVE BUY (${tradeParams.amountSol} SOL)`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(approveLabel, `APPROVE_${approvalId}`)],
      [Markup.button.callback('❌ CANCEL', `CANCEL_${approvalId}`)],
      [Markup.button.callback('🔄 Refresh Price', `REFRESH_APPROVAL_${approvalId}`)],
    ]);

    this.pendingApprovals.set(approvalId, request);

    // ── Reminder: edit pesan asli tambahin sisa waktu ─────────
    const reminderTimer = setTimeout(async () => {
      if (!this.pendingApprovals.has(approvalId)) return;
      const req = this.pendingApprovals.get(approvalId);
      if (!req?.messageId) return;

      logger.info(MODULE, `Reminder edit: ${token.symbol}`);
      try {
        await this.bot.telegram.editMessageText(
          config.telegram.chatId,
          req.messageId,
          undefined,
          message + `\n\n_⏰ ${reminderMin}min remaining — segera klik tombol_`,
          { parse_mode: 'Markdown', link_preview_options: { is_disabled: true }, ...keyboard }
        );
      } catch {
        // Ignore edit errors
      }
    }, REMINDER_AT_MS);

    // ── Auto-expire saat TTL habis ────────────────────────────
    setTimeout(async () => {
      clearTimeout(reminderTimer);
      if (!this.pendingApprovals.has(approvalId)) return;

      const req = this.pendingApprovals.get(approvalId);
      this.pendingApprovals.delete(approvalId);
      this.riskManager.clearPendingApproval(token.address);
      this.sentAlertMessages.delete(token.address);
      this.addMissed(signal, 'EXPIRED');

      logger.info(MODULE, `Signal expired (${ttlMin}min): ${token.symbol}`);

      if (req?.messageId) {
        try {
          await this.bot.telegram.editMessageText(
            config.telegram.chatId,
            req.messageId,
            undefined,
            (isDryRun ? `🧪 *DRY RUN* ` : '') +
            `🎯 *${signal.confidence}* ${confEmoji} | *${safeSymbolStr}*\n` +
            `📊 $${formatNumber(token.mcapUsd)} | 💧 $${formatNumber(token.liquidityUsd)} | 🕐 ${tokenAge}h${tokenAgeMin}m\n\n` +
            `📈 EMA${signal.emaTouched} Touch ✅ | RSI K:${signal.stochRsiK.toFixed(1)} D:${signal.stochRsiD.toFixed(1)}\n\n` +
            `⏰ *EXPIRED* — tidak direspons dalam ${ttlMin} menit.`,
            { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
          );
        } catch {
          // Ignore edit errors
        }
      }
    }, APPROVAL_TTL_MS);

    // ── Hapus alert lama untuk token yang sama ────────────────
    const oldMessageId = this.sentAlertMessages.get(token.address);
    if (oldMessageId) {
      try {
        await this.bot.telegram.deleteMessage(config.telegram.chatId, oldMessageId);
        logger.info(MODULE, `Deleted old alert for ${token.symbol} (msg:${oldMessageId})`);
      } catch {
        // Pesan mungkin sudah dihapus user atau expired — abaikan error
      }
    }

    // ── Kirim alert message ───────────────────────────────────
    try {
      const sent = await this.bot.telegram.sendMessage(config.telegram.chatId, message, {
        parse_mode: 'Markdown',
        ...keyboard,
        link_preview_options: { is_disabled: true },
      } as Parameters<typeof this.bot.telegram.sendMessage>[2]);
      request.messageId = sent.message_id;
      this.sentAlertMessages.set(token.address, sent.message_id);
      logger.info(MODULE, `Alert sent: ${token.symbol} (msg:${sent.message_id})`);
    } catch (err) {
      logger.error(MODULE, 'Failed to send alert', err);
    }

    return approvalId;
  }

  async sendTradeResult(
    symbol: string,
    success: boolean,
    details: { amountSol?: number; txSignature?: string; bundleId?: string; error?: string; side?: 'BUY' | 'SELL' }
  ): Promise<void> {
    const side = details.side ?? 'BUY';
    const safeSym = safeSymbol(symbol);
    const message = success
      ? `✅ *${side} EXECUTED*\n\n` +
        `🪙 Token: ${safeSym}\n` +
        (details.amountSol ? `💰 Amount: ${details.amountSol} SOL\n` : '') +
        (details.bundleId ? `📦 Bundle: ${details.bundleId.slice(0, 12)}...\n` : '') +
        (side === 'BUY' ? `\n⚠️ *Monitor posisi — exit manual saat RSI puncak*` : `\n📊 Position closed.`)
      : `❌ *${side} FAILED*\n\n` +
        `🪙 Token: ${safeSym}\n` +
        `Reason: ${escapeMarkdown(details.error ?? 'Unknown error')}`;

    await this.sendMessage(message);
  }

  async sendSellResult(
    symbol: string,
    success: boolean,
    details: { bundleId?: string; error?: string; solReceived?: number; exitPriceUsd?: number; pnlPct?: number; side?: 'SELL'; amountSol?: number }
  ): Promise<void> {
    const safeSym = safeSymbol(symbol);
    // Hitung PnL dalam SOL
    let solPnlLine = '';
    if (details.solReceived !== undefined && details.amountSol !== undefined) {
      const solPnl = details.solReceived - details.amountSol;
      const solPnlEmoji = solPnl >= 0 ? '🟢' : '🔴';
      solPnlLine = `${solPnlEmoji} SOL PnL: ${solPnl >= 0 ? '+' : ''}${solPnl.toFixed(4)} SOL ` +
        `(${details.pnlPct !== undefined ? (details.pnlPct >= 0 ? '+' : '') + details.pnlPct.toFixed(2) : '0.00'}%)\n`;
    }
    const message = success
      ? `✅ *SELL EXECUTED*\n\n` +
        `🪙 Token: ${safeSym}\n` +
        (details.amountSol ? `💎 SOL invested: ${details.amountSol.toFixed(4)} SOL\n` : '') +
        (details.solReceived ? `💰 SOL received: ${details.solReceived.toFixed(4)} SOL\n` : '') +
        solPnlLine +
        (details.exitPriceUsd ? `💵 Exit price: $${details.exitPriceUsd.toFixed(8)}\n` : '') +
        (details.bundleId ? `📦 Bundle: ${details.bundleId.slice(0, 12)}...\n` : '')
      : `❌ *SELL FAILED*\n\n` +
        `🪙 Token: ${safeSym}\n` +
        `Reason: ${escapeMarkdown(details.error ?? 'Unknown error')}`;

    await this.sendMessage(message);
  }

  async sendExitSignalAlert(signal: ExitSignal): Promise<void> {
    const { position, reason, pnlPct, stochRsiK, stochRsiD, isPartial } = signal;
    const pnlStr = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
    const safeSym = safeSymbol(position.symbol);

    const headers: Record<string, string> = {
      RSI_PEAK:        '📈 *RSI PEAK — PERTIMBANGKAN JUAL*',
      RSI_DROP:        '📉 *RSI TURUN DARI PEAK — MOMENTUM BERBALIK*',
      STOP_LOSS_PCT:   '🚨 *STOP LOSS — JUAL SEGERA*',
      TAKE_PROFIT_PCT: '🎯 *TARGET PROFIT TERCAPAI*',
      TRAILING_STOP:   '🛡 *TRAILING STOP — PROFIT DIKUNCI*',
      PARTIAL_PROFIT:  '💰 *PARTIAL PROFIT — JUAL SEBAGIAN*',
      TIME_EXIT:       '⏰ *TIME EXIT — POSISI STAGNAN*',
    };

    const urgency: Record<string, string> = {
      RSI_PEAK:        '💡 Exit sekarang atau tunggu konfirmasi RSI drop',
      RSI_DROP:        '⚠️ Momentum sudah berbalik — pertimbangkan exit',
      STOP_LOSS_PCT:   '🔴 *Loss melebihi threshold — exit manual segera*',
      TAKE_PROFIT_PCT: '💡 Tunggu RSI peak >80 untuk exit optimal',
      TRAILING_STOP:   '🛡 Profit sudah turun dari peak — jual sebelum loss!',
      PARTIAL_PROFIT:  '💰 Lock profit 50% dulu, sisanya biarkan jalan',
      TIME_EXIT:       '⏰ Posisi terlalu lama stagnan — cut loss & cari lain',
    };

    const rsiInfo = stochRsiK !== undefined
      ? `• Stoch RSI K: ${stochRsiK.toFixed(1)} | D: ${(stochRsiD ?? 0).toFixed(1)}\n`
      : '';

    const holdMin = Math.floor((Date.now() - position.entryTimestamp) / 60000);

    const text =
      `${headers[reason] ?? reason}\n\n` +
      `🪙 *${safeSym}*\n` +
      `💰 PnL: ${pnlStr}\n` +
      `📥 Entry: $${position.entryPriceUsd.toFixed(8)}\n` +
      `💵 Sekarang: $${signal.currentPrice.toFixed(8)}\n` +
      rsiInfo +
      `⏱ Hold: ${holdMin}m\n\n` +
      `${urgency[reason] ?? ''}\n\n` +
      (isPartial ? `_⚠️ Ini alert PARTIAL — jual sebagian posisi saja_\n\n` : '') +
      `🔗 [DexScreener](https://dexscreener.com/solana/${position.tokenAddress})`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`🔴 SELL NOW ${safeSym}${isPartial ? ' (50%)' : ''}`, `SELL_${position.id}`)],
      [Markup.button.callback('🔄 Refresh Price', `REFRESH_EXIT_${position.id}`)],
      [Markup.button.callback('✖️ DISMISS', 'DISMISS_EXIT')],
    ]);

    await this.sendMessageWithKeyboard(text, keyboard);
    logger.info(MODULE, `Exit alert: ${position.symbol} [${reason}] PnL:${pnlStr}`);
  }

  async sendMessage(text: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(config.telegram.chatId, text, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
    } catch (err: any) {
      // Fallback ke plain text kalau Markdown parse error
      if (err?.response?.error_code === 400) {
        logger.warn(MODULE, 'Markdown parse error, falling back to plain text');
        try {
          await this.bot.telegram.sendMessage(config.telegram.chatId, text, {
            link_preview_options: { is_disabled: true },
          });
        } catch (err2) {
          logger.error(MODULE, 'sendMessage plain fallback failed', err2);
        }
      } else {
        logger.error(MODULE, 'sendMessage failed', err);
      }
    }
  }

  private async sendMessageWithKeyboard(text: string, keyboard: any): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(config.telegram.chatId, text, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        ...keyboard,
      } as any);
    } catch (err: any) {
      // Fallback ke plain text kalau Markdown parse error — tombol tetap muncul
      if (err?.response?.error_code === 400) {
        logger.warn(MODULE, 'Markdown parse error in keyboard msg, falling back to plain text');
        try {
          await this.bot.telegram.sendMessage(config.telegram.chatId, text, {
            link_preview_options: { is_disabled: true },
            ...keyboard,
          } as any);
        } catch (err2) {
          logger.error(MODULE, 'sendMessageWithKeyboard plain fallback failed', err2);
        }
      } else {
        logger.error(MODULE, 'sendMessageWithKeyboard failed', err);
      }
    }
  }

  async launch(): Promise<void> {
    try {
      await this.bot.telegram.setMyCommands([
        { command: 'start',      description: '🏠 Menu utama' },
        { command: 'status',     description: '📊 Status bot & scanner' },
        { command: 'positions',  description: '📂 Open positions' },
        { command: 'pnl',        description: '📊 Total PnL summary' },
        { command: 'settings',   description: '⚙️ Ubah parameter trading' },
        { command: 'scan',       description: '🔍 Trigger scan manual' },
        { command: 'missed',     description: '⏭ Signal yang terlewat' },
        { command: 'dryreport',  description: '📝 Laporan paper trading' },
        { command: 'help',       description: '❓ Panduan singkat' },
        { command: 'ping',       description: '🏓 Cek bot masih hidup' },
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
