// src/execution/executor.ts
// Trade executor: combines Jupiter quote + Jito bundle submission

import {
  Connection,
  PublicKey,
} from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { WalletManager } from './wallet';
import { JupiterClient } from './jupiter';
import { JitoExecutor } from './jito';
import { DryRunExecutor } from './dryrun';
import { RiskManager } from '../risk/manager';
import { TelegramBot } from '../telegram/bot';
import { ApprovalRequest, Position } from '../utils/types';

const MODULE = 'EXECUTOR';

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export class TradeExecutor {
  private jupiterClient: JupiterClient;
  private jitoExecutor: JitoExecutor;
  private walletManager: WalletManager;
  private riskManager: RiskManager;
  private telegramBot: TelegramBot;
  private dryRunExecutor: DryRunExecutor;

  constructor(
    connection: Connection,
    walletManager: WalletManager,
    riskManager: RiskManager,
    telegramBot: TelegramBot
  ) {
    this.jupiterClient   = new JupiterClient(connection);
    this.jitoExecutor    = new JitoExecutor(connection);
    this.walletManager   = walletManager;
    this.riskManager     = riskManager;
    this.telegramBot     = telegramBot;
    this.dryRunExecutor  = new DryRunExecutor(riskManager, telegramBot);
    // Inject into bot so /dryreport command works
    this.telegramBot.dryRunExecutor = this.dryRunExecutor;
  }

  /**
   * Execute trade setelah user approve di Telegram.
   * Kalau DRY_RUN=true → route ke dryRunExecutor (zero on-chain action).
   * Kalau live → safety checks → Jupiter → Jito.
   */
  async executeTrade(request: ApprovalRequest): Promise<void> {
    const { signal, tradeParams } = request;
    const token = signal.token;

    // ── DRY RUN INTERCEPT ──────────────────────────────────
    if (config.dryRun) {
      logger.info(MODULE, `🧪 [DRY RUN] Routing to paper executor: ${token.symbol}`);
      await this.dryRunExecutor.simulateTrade(request);
      return;
    }
    // ───────────────────────────────────────────────────────

    logger.info(MODULE, `⚡ Executing trade: ${token.symbol} | ${tradeParams.amountSol} SOL`);

    // --- SAFETY CHECKS sebelum eksekusi ---

    // 1. Re-check balance (bisa saja balance berubah sejak quote)
    const balanceCheck = await this.walletManager.hasSufficientBalance(tradeParams.amountSol);
    if (!balanceCheck.sufficient) {
      const reason = `Insufficient balance: ${balanceCheck.balance.toFixed(4)} SOL < ${balanceCheck.required.toFixed(4)} SOL required`;
      logger.error(MODULE, reason);
      await this.telegramBot.sendTradeResult(token.symbol, false, {
        amountSol: tradeParams.amountSol,
        error: reason,
      });
      return;
    }

    // 2. Re-check risk (bisa saja ada posisi baru yang masuk)
    const riskCheck = this.riskManager.canTrade(token.address);
    if (!riskCheck.allowed) {
      logger.warn(MODULE, `Risk check failed: ${riskCheck.reason}`);
      await this.telegramBot.sendTradeResult(token.symbol, false, {
        amountSol: tradeParams.amountSol,
        error: riskCheck.reason,
      });
      return;
    }

    // 3. Re-fetch fresh quote (quote lama mungkin sudah stale)
    logger.info(MODULE, `Re-fetching fresh quote for ${token.symbol}...`);
    const freshQuote = await this.jupiterClient.getQuote(
      token.address,
      tradeParams.amountSol,
      tradeParams.slippagePct
    );

    if (!freshQuote) {
      const reason = 'Failed to get fresh Jupiter quote';
      logger.error(MODULE, reason);
      await this.telegramBot.sendTradeResult(token.symbol, false, { amountSol: tradeParams.amountSol, error: reason });
      return;
    }

    // 4. Final price impact check dengan quote terbaru
    if (freshQuote.priceImpactPct > tradeParams.maxPriceImpactPct) {
      const reason = `Fresh quote price impact too high: ${freshQuote.priceImpactPct.toFixed(2)}% (max ${tradeParams.maxPriceImpactPct}%)`;
      logger.warn(MODULE, reason);
      await this.telegramBot.sendTradeResult(token.symbol, false, { amountSol: tradeParams.amountSol, error: reason });
      this.riskManager.clearPendingApproval(token.address);
      return;
    }

    // 5. Build swap transaction
    const jitoTipLamports = Math.floor(config.jito.tipAmount * 1_000_000_000);
    const swapTx = await this.jupiterClient.buildSwapTransaction(
      freshQuote,
      this.walletManager.publicKey,
      jitoTipLamports
    );

    if (!swapTx) {
      const reason = 'Failed to build swap transaction';
      logger.error(MODULE, reason);
      await this.telegramBot.sendTradeResult(token.symbol, false, { amountSol: tradeParams.amountSol, error: reason });
      return;
    }

    // 6. Sign swap transaction
    swapTx.sign([this.walletManager.keypair]);

    // 7. Execute via Jito Bundle
    logger.info(MODULE, `Submitting Jito bundle for ${token.symbol}...`);
    const result = await this.jitoExecutor.executeSwapBundle(
      swapTx,
      this.walletManager.keypair
    );

    if (!result.success) {
      logger.error(MODULE, `Trade failed: ${result.error}`);
      await this.telegramBot.sendTradeResult(token.symbol, false, {
        amountSol: tradeParams.amountSol,
        bundleId: result.bundleId,
        error: result.error,
      });
      this.riskManager.clearPendingApproval(token.address);
      return;
    }

    // 8. Trade berhasil — catat position
    const tokensReceived = Number(freshQuote.outAmount);
    const solPriceUsd = await this.walletManager.getSOLPriceUSD();
    const entryPriceUsd = (tradeParams.amountSol * solPriceUsd) / (tokensReceived || 1);

    const position: Position = {
      id: generateId(),
      tokenAddress: token.address,
      symbol: token.symbol,
      entryPriceUsd,
      amountSol: tradeParams.amountSol,
      tokensReceived,
      entryTimestamp: Date.now(),
      txSignature: result.bundleId ?? 'jito_bundle',
      status: 'OPEN',
    };

    this.riskManager.addPosition(position);

    logger.info(MODULE, `✅ Trade SUCCESS: ${token.symbol} | BundleID: ${result.bundleId?.slice(0, 12)}`);
    await this.telegramBot.sendTradeResult(token.symbol, true, {
      amountSol: tradeParams.amountSol,
      bundleId: result.bundleId,
    });
  }
}
