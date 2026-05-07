// src/orchestrator.ts
// Main Bot Orchestrator - coordinates scanner, analysis, execution

import { Connection } from '@solana/web3.js';
import cron from 'node-cron';
import { config, maskUrl } from './config';
import { logger } from './utils/logger';
import { ScannerRouter, RPCConnectionManager } from './scanner/index';
import { GMGNScanner } from './scanner/gmgn';
import { DexScreenerScanner } from './scanner/dexscreener';
import { analyzeTokens } from './analysis/indicators';
import { TradeSimulator } from './execution/simulation';
import { TradeExecutor } from './execution/executor';
import { WalletManager } from './execution/wallet';
import { RiskManager, ExitSignal } from './risk/manager';
import { TelegramBot } from './telegram/bot';
import { ApprovalRequest, SignalResult, OHLCVCandle } from './utils/types';
import { PositionStore } from './utils/store';

const MODULE = 'ORCHESTRATOR';

export class BotOrchestrator {
  private connection: Connection;
  private rpcManager: RPCConnectionManager;
  private scanner: ScannerRouter;
  private gmgnScanner: GMGNScanner;
  private dsScanner: DexScreenerScanner;
  private simulator: TradeSimulator;
  private executor: TradeExecutor;
  private walletManager: WalletManager;
  private riskManager: RiskManager;
  private telegramBot: TelegramBot;
  private store: PositionStore;

  private isRunning: boolean = false;
  private scanTask: cron.ScheduledTask | null = null;
  private monitorTask: cron.ScheduledTask | null = null;
  private isScanInProgress: boolean = false;
  private isMonitorInProgress: boolean = false;

  constructor() {
    this.rpcManager  = new RPCConnectionManager();
    this.connection  = this.rpcManager.getConnection();

    this.gmgnScanner = new GMGNScanner();
    this.dsScanner   = new DexScreenerScanner();
    this.scanner     = new ScannerRouter();

    // Persistence store (load from disk if exists)
    this.store = new PositionStore();

    this.riskManager   = new RiskManager();
    this.riskManager.setStore(this.store);

    this.walletManager = new WalletManager(this.connection);
    this.simulator     = new TradeSimulator(this.connection);
    this.telegramBot   = new TelegramBot(this.riskManager);
    this.executor      = new TradeExecutor(
      this.connection,
      this.walletManager,
      this.riskManager,
      this.telegramBot
    );

    // Wire persistence + cross-references
    this.executor.setStore(this.store);
    this.telegramBot.setTradeExecutor(this.executor);
    this.telegramBot.scannerRouter = this.scanner;

    this.setupCallbacks();
    this.setupRiskEvents();
  }

  // ── Wiring ────────────────────────────────────────────────────

  private setupCallbacks(): void {
    this.telegramBot.onApprove(async (request: ApprovalRequest) => {
      await this.executor.executeTrade(request);
    });

    // Wire /scan command ke runScanCycle
    this.telegramBot.onManualScan(async () => {
      await this.telegramBot.sendMessage('🔍 *Scan manual dimulai...*');
      await this.runScanCycle();
    });
  }

  private setupRiskEvents(): void {
    // Single unified exit signal handler — covers RSI peak, stop loss, take profit
    this.riskManager.on('exitSignal', async (signal: ExitSignal) => {
      await this.telegramBot.sendExitSignalAlert(signal);
    });

    this.riskManager.on('position:opened', (pos: { symbol: string; amountSol: number }) => {
      logger.info(MODULE, `📂 Opened: ${pos.symbol} | ${pos.amountSol} SOL`);
    });

    this.riskManager.on('position:closed', (data: { position: { symbol: string }; pnlPct: number }) => {
      logger.info(MODULE, `📁 Closed: ${data.position.symbol} | PnL: ${data.pnlPct.toFixed(2)}%`);
    });
  }

  // ── Scan Cycle ────────────────────────────────────────────────

  private async runScanCycle(): Promise<void> {
    if (this.isScanInProgress) {
      logger.debug(MODULE, 'Scan in progress — skipping tick');
      return;
    }
    this.isScanInProgress = true;

    try {
      logger.info(MODULE, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.info(MODULE, `🔄 Scan | ${new Date().toLocaleTimeString()}`);

      const { tokens, source } = await this.scanner.scan();

      if (!tokens.length) {
        logger.info(MODULE, 'No tokens passed filters');
        // Kirim info ke Telegram supaya user tau bot masih jalan
        await this.telegramBot.sendMessage(
          `🔄 *Scan selesai* — [${source.toUpperCase()}]\n` +
          `📭 Tidak ada token yang lolos filter saat ini.\n` +
          `_Filter: MCap >$${(config.trading.minMcapUsd/1000).toFixed(0)}K, Age >${config.trading.minTokenAgeSeconds/3600}h_`
        );
        return;
      }

      logger.info(MODULE, `📊 [${source.toUpperCase()}] ${tokens.length} tokens`);

      // Log tiap token yang lolos untuk debug
      tokens.forEach(t => {
        logger.info(MODULE, `  ✓ ${t.symbol} | MCap:$${(t.mcapUsd/1000).toFixed(0)}K | Age:${Math.floor(t.ageSeconds/3600)}h | OHLCV:${t.ohlcv.length}`);
      });

      const signals = analyzeTokens(tokens);
      logger.info(MODULE, `📡 ${signals.length} signal(s) dari ${tokens.length} tokens`);

      if (!signals.length) {
        // Kirim summary ke Telegram — user tau scan jalan tapi belum ada setup yang pas
        const tokenList = tokens.slice(0, 5).map(t =>
          `• ${t.symbol} $${(t.mcapUsd/1000).toFixed(0)}K | OHLCV:${t.ohlcv.length}`
        ).join('\n');

        await this.telegramBot.sendMessage(
          `🔄 *Scan selesai* — [${source.toUpperCase()}]\n` +
          `📊 ${tokens.length} token lolos filter, belum ada signal EMA+RSI.\n\n` +
          `*Token yang discan:*\n${tokenList}\n\n` +
          `_Signal butuh: harga di EMA + Stoch RSI < 20_`
        );
        return;
      }

      // Ada signal — proses
      for (const signal of signals) {
        await this.processSignal(signal);
        await sleep(500);
      }
    } catch (err) {
      logger.error(MODULE, 'Scan error', err);
      await this.telegramBot.sendMessage(`❌ *Scan error*\n\`${String(err).slice(0, 200)}\``);
    } finally {
      this.isScanInProgress = false;
    }
  }

  private async processSignal(signal: SignalResult): Promise<void> {
    const token = signal.token;

    const riskEval = this.riskManager.evaluateSignal(signal);
    if (!riskEval.shouldAlert) {
      logger.debug(MODULE, `⏭ ${token.symbol}: ${riskEval.reason}`);
      return;
    }

    logger.info(MODULE, `🎯 ${token.symbol} [${signal.confidence}] EMA${signal.emaTouched} RSI:${signal.stochRsiK.toFixed(0)}`);
    this.riskManager.registerPendingApproval(token.address);

    const preCheck = await this.simulator.preTradeCheck(signal, this.walletManager.publicKey);
    if (!preCheck.approved) {
      logger.warn(MODULE, `❌ ${token.symbol}: ${preCheck.reason}`);
      this.riskManager.clearPendingApproval(token.address);
      return;
    }

    await this.telegramBot.sendSignalAlert(
      signal,
      preCheck.tradeParams,
      preCheck.quoteResult!,
      preCheck.simulationResult
    );
  }

  // ── Monitor Cycle ─────────────────────────────────────────────

  private async runMonitorCycle(): Promise<void> {
    const openPositions = this.riskManager.getOpenPositions();
    if (!openPositions.length || this.isMonitorInProgress) return;
    this.isMonitorInProgress = true;

    logger.info(MODULE, `👁 Monitor: ${openPositions.length} position(s)`);

    try {
      const priceMap = new Map<string, number>();
      const ohlcvMap = new Map<string, OHLCVCandle[]>();

      for (const pos of openPositions) {
        let priceFound = false;

        // Step 1: coba GMGN dulu
        try {
          const detail = await this.gmgnScanner.fetchTokenDetail(pos.tokenAddress);
          if (detail && detail.priceUsd > 0) {
            priceMap.set(pos.tokenAddress, detail.priceUsd);
            if (detail.ohlcv.length >= 40) ohlcvMap.set(pos.tokenAddress, detail.ohlcv);
            priceFound = true;
            logger.info(MODULE, `Price OK (GMGN): ${pos.symbol} $${detail.priceUsd}`);
          }
        } catch {
          // GMGN gagal — lanjut ke DS
        }

        // Step 2: DexScreener fallback kalau GMGN null/gagal
        if (!priceFound) {
          try {
            const pairs = await this.dsScanner.fetchTokensByAddress([pos.tokenAddress]);
            // pairs bisa array DSPair atau array dengan priceUsd field
            const pair = pairs[0] as any;
            const price = parseFloat(pair?.priceUsd ?? pair?.price_usd ?? '0');
            if (price > 0) {
              priceMap.set(pos.tokenAddress, price);
              priceFound = true;
              logger.info(MODULE, `Price OK (DS): ${pos.symbol} $${price}`);
            }
          } catch {
            logger.warn(MODULE, `Price fetch failed: ${pos.symbol}`);
          }
        }

        if (!priceFound) {
          logger.warn(MODULE, `No price for ${pos.symbol} — PnL tidak bisa dihitung`);
        }

        await sleep(1000); // rate limit friendly
      }

      logger.info(MODULE, `Monitor: ${priceMap.size}/${openPositions.length} prices updated`);

      // Update harga di RiskManager supaya /positions tampilkan PnL
      this.riskManager.updatePrices(priceMap);

      // Update paper trade prices untuk dry run report
      if (config.dryRun && this.executor['dryRunExecutor']) {
        for (const [addr, price] of priceMap) {
          const logStr = this.executor['dryRunExecutor'].updatePaperPrice(addr, price);
          if (logStr) logger.debug(MODULE, logStr);
        }
      }

      // Evaluasi exit signals — RSI peak + SL + TP
      this.riskManager.checkExitSignals(priceMap, ohlcvMap);

    } catch (err) {
      logger.error(MODULE, 'Monitor error', err);
    } finally {
      this.isMonitorInProgress = false;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) return;
    logger.info(MODULE, '🚀 Starting Solana Degen Bot...');

    // RPC health check — auto-rotate kalau gagal
    let rpcOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const slot = await this.connection.getSlot();
        logger.info(MODULE, `✅ RPC OK | Slot: ${slot} | ${maskUrl(this.rpcManager.getCurrentUrl())}`);
        rpcOk = true;
        break;
      } catch {
        logger.warn(MODULE, `RPC attempt ${attempt + 1} failed, rotating...`);
        this.rpcManager.rotate();
        this.connection = this.rpcManager.getConnection();
        await sleep(1000);
      }
    }
    if (!rpcOk) throw new Error('All RPC endpoints failed');

    // Wallet summary — timeout guard (CoinGecko kadang lambat)
    logger.info(MODULE, 'Fetching wallet info...');
    const walletSummary = await Promise.race([
      this.walletManager.getSummary(),
      sleep(5000).then(() => '💳 Wallet loaded (price fetch timeout)'),
    ]) as string;
    logger.info(MODULE, 'Wallet info OK');

    // Telegram launch — non-blocking agar cron setup tidak tertahan
    logger.info(MODULE, 'Launching Telegram bot...');
    this.telegramBot.launch().catch((e) => {
      logger.error(MODULE, 'Telegram launch error', e);
    });
    // Beri waktu sebentar untuk polling terhubung
    await sleep(3000);
    logger.info(MODULE, 'Telegram bot OK');

    await this.telegramBot.sendMessage(
      `🚀 *VANGUARD-01 Online*\n\n` +
      `${walletSummary}\n\n` +
      `⚙️ *Trading Config*\n` +
      `• Trade size: ${config.trading.maxTradeSol} SOL\n` +
      `• Min MCap: $${(config.trading.minMcapUsd / 1000).toFixed(0)}K\n` +
      `• Min age: ${config.trading.minTokenAgeSeconds / 3600}h\n` +
      `• Stop Loss: -${config.risk.stopLossPct}%\n` +
      `• RSI exit: K/D > 80 (Obicle method)\n` +
      `• Scan setiap: ${config.scanning.intervalSeconds / 60} menit\n` +
      `• Monitor: tiap 2 menit\n\n` +
      `📡 Data: GMGN.ai → DexScreener (fallback)\n` +
      `🛡 Eksekusi: Jito Bundle (anti-MEV)\n\n` +
      `✅ Scanning...`
    );

    // Jadwal scan utama
    this.scanTask = cron.schedule(secondsToCron(config.scanning.intervalSeconds), () => {
      this.runScanCycle().catch((e) => logger.error(MODULE, 'Scan cron error', e));
    });

    // Monitor position — pakai setInterval bukan cron (lebih reliable)
    // Jalan tiap 2 menit = 120,000 ms
    const monitorInterval = setInterval(() => {
      this.runMonitorCycle().catch((e) => logger.error(MODULE, 'Monitor error', e));
    }, 120_000);

    // Simpan reference untuk cleanup saat stop
    this.monitorTask = {
      stop: () => clearInterval(monitorInterval),
    } as unknown as cron.ScheduledTask;

    this.isRunning = true;
    logger.info(MODULE, `✅ Live | scan/${config.scanning.intervalSeconds}s | monitor/120s (setInterval)`);

    // Initial scan langsung
    await sleep(2000);
    this.runScanCycle().catch((e) => logger.error(MODULE, 'Initial scan error', e));
  }

  async stop(signal?: string): Promise<void> {
    logger.info(MODULE, `Stopping... (${signal ?? 'manual'})`);
    this.scanTask?.stop();
    this.monitorTask?.stop();
    this.telegramBot.stop(signal);
    this.isRunning = false;
    await this.telegramBot.sendMessage(`🛑 *Bot Stopped* | \`${signal ?? 'manual'}\``).catch(() => {});
    logger.info(MODULE, 'Shutdown complete');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function secondsToCron(seconds: number): string {
  if (seconds < 60) return `*/${seconds} * * * * *`;
  return `*/${Math.floor(seconds / 60)} * * * *`;
}
