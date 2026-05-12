// src/execution/executor.ts
// Trade executor: combines Jupiter quote + Jito bundle submission

import {
  Connection,
  PublicKey,
} from '@solana/web3.js';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { WalletManager } from './wallet';
import { JupiterClient } from './jupiter';
import { JitoExecutor } from './jito';
import { DryRunExecutor } from './dryrun';
import { RiskManager } from '../risk/manager';
import { TelegramBot } from '../telegram/bot';
import { ApprovalRequest, Position } from '../utils/types';
import { calculateVolatility, calculateDynamicSlippage } from '../analysis/indicators';
import { PositionStore } from '../utils/store';

const MODULE = 'EXECUTOR';

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Fetch fresh price dari DexScreener — fallback kalau cache kosong (misal setelah restart)
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
      if (price > 0) return price;
    }
  } catch (err) {
    logger.debug(MODULE, `fetchFreshPrice failed for ${tokenAddress.slice(0, 8)}`);
  }
  return null;
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

  setStore(store: PositionStore): void {
    this.dryRunExecutor.setStore(store);
  }

  /**
   * Execute BUY trade setelah user approve di Telegram.
   * Kalau DRY_RUN=true → route ke dryRunExecutor (zero on-chain action).
   * Kalau live → safety checks → Jupiter → Jito.
   */
  async executeTrade(request: ApprovalRequest): Promise<void> {
    const { signal, tradeParams } = request;
    const token = signal.token;

    // ── DRY RUN INTERCEPT ──────────────────────────────────
    if (config.dryRun) {
      // Re-check risk guard — bisa saja posisi sudah terbuka dari alert lain
      const riskCheck = this.riskManager.canTrade(token.address);
      if (!riskCheck.allowed) {
        logger.warn(MODULE, `🧪 [DRY RUN] Risk check failed: ${riskCheck.reason}`);
        await this.telegramBot.sendTradeResult(token.symbol, false, {
          amountSol: tradeParams.amountSol,
          error: riskCheck.reason,
        });
        this.riskManager.clearPendingApproval(token.address);
        return;
      }
      logger.info(MODULE, `🧪 [DRY RUN] Routing to paper executor: ${token.symbol}`);
      await this.dryRunExecutor.simulateTrade(request);
      return;
    }
    // ───────────────────────────────────────────────────────

    logger.info(MODULE, `⚡ Executing BUY: ${token.symbol} | ${tradeParams.amountSol} SOL`);

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
    logger.info(MODULE, `Re-fetching fresh buy quote for ${token.symbol}...`);
    const freshQuote = await this.jupiterClient.getBuyQuote(
      token.address,
      tradeParams.amountSol,
      tradeParams.slippagePct
    );

    if (!freshQuote) {
      const reason = 'Failed to get fresh Jupiter buy quote';
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
    const tokensReceivedRaw = freshQuote.outAmount.toString();
    const solPriceUsd = await this.walletManager.getSOLPriceUSD();
    const entryPriceUsd = (tradeParams.amountSol * solPriceUsd) / (tokensReceived || 1);

    const position: Position = {
      id: generateId(),
      tokenAddress: token.address,
      symbol: token.symbol,
      entryPriceUsd,
      amountSol: tradeParams.amountSol,
      tokensReceived,
      tokensReceivedRaw,
      entryTimestamp: Date.now(),
      txSignature: result.bundleId ?? 'jito_bundle',
      status: 'OPEN',
    };

    this.riskManager.addPosition(position);

    logger.info(MODULE, `✅ BUY SUCCESS: ${token.symbol} | BundleID: ${result.bundleId?.slice(0, 12)}`);
    await this.telegramBot.sendTradeResult(token.symbol, true, {
      amountSol: tradeParams.amountSol,
      bundleId: result.bundleId,
      side: 'BUY',
    });
  }

  /**
   * Execute SELL trade (100% of position tokens → SOL).
   * Triggered by user clicking SELL button or /sell command.
   */
  async executeSell(position: Position): Promise<void> {
    const { symbol, tokenAddress, tokensReceivedRaw } = position;

    // Determine exact amount to sell
    const sellAmountRaw = tokensReceivedRaw ?? String(Math.floor(position.tokensReceived));
    if (!sellAmountRaw || sellAmountRaw === '0') {
      const reason = 'Invalid token amount for sell';
      logger.error(MODULE, reason);
      await this.telegramBot.sendSellResult(symbol, false, { error: reason });
      return;
    }

    // ── DRY RUN INTERCEPT ──────────────────────────────────
    if (config.dryRun) {
      logger.info(MODULE, `🧪 [DRY RUN] Simulating sell: ${symbol}`);
      // Selalu fetch harga fresh — jangan andalkan cache yang mungkin kosong setelah restart
      const cachedPrice = this.riskManager.getLastKnownPrice(tokenAddress);
      const freshPrice = cachedPrice ? null : await fetchFreshPriceUSD(tokenAddress);
      const exitPriceUsd = cachedPrice ?? freshPrice ?? position.entryPriceUsd;
      this.dryRunExecutor.closePaperTrade(tokenAddress, exitPriceUsd);
      this.riskManager.closePosition(position.id, exitPriceUsd);
      // Simulasi SOL received untuk dry run
      const solReceivedDryRun = position.entryPriceUsd > 0
        ? position.amountSol * (exitPriceUsd / position.entryPriceUsd)
        : position.amountSol;
      await this.telegramBot.sendSellResult(symbol, true, {
        side: 'SELL',
        exitPriceUsd,
        pnlPct: ((exitPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100,
        solReceived: solReceivedDryRun,
        amountSol: position.amountSol,
      });
      return;
    }
    // ───────────────────────────────────────────────────────

    logger.info(MODULE, `⚡ Executing SELL: ${symbol} | amountRaw: ${sellAmountRaw}`);

    // 1. Dynamic slippage for sell (fallback to ~1.75% if no OHLCV)
    let slippagePct = 1.75;
    // Try to get token OHLCV from risk manager if available (optional future enhancement)
    // For now use middle-ground to avoid excessive fees while ensuring execution
    if (slippagePct > config.trading.slippageMaxPct) {
      slippagePct = config.trading.slippageMaxPct;
    }

    // 2. Re-fetch fresh SELL quote
    logger.info(MODULE, `Re-fetching fresh sell quote for ${symbol}...`);
    const freshQuote = await this.jupiterClient.getSellQuote(
      tokenAddress,
      sellAmountRaw,
      slippagePct
    );

    if (!freshQuote) {
      const reason = 'Failed to get fresh Jupiter sell quote';
      logger.error(MODULE, reason);
      await this.telegramBot.sendSellResult(symbol, false, { error: reason });
      return;
    }

    // 3. Price impact check
    if (freshQuote.priceImpactPct > config.trading.maxPriceImpactPct) {
      const reason = `Sell price impact too high: ${freshQuote.priceImpactPct.toFixed(2)}% (max ${config.trading.maxPriceImpactPct}%)`;
      logger.warn(MODULE, reason);
      await this.telegramBot.sendSellResult(symbol, false, { error: reason });
      return;
    }

    // 4. Build swap transaction (direction handled by quote)
    const jitoTipLamports = Math.floor(config.jito.tipAmount * 1_000_000_000);
    const swapTx = await this.jupiterClient.buildSwapTransaction(
      freshQuote,
      this.walletManager.publicKey,
      jitoTipLamports
    );

    if (!swapTx) {
      const reason = 'Failed to build sell swap transaction';
      logger.error(MODULE, reason);
      await this.telegramBot.sendSellResult(symbol, false, { error: reason });
      return;
    }

    // 5. Sign
    swapTx.sign([this.walletManager.keypair]);

    // 6. Execute via Jito
    logger.info(MODULE, `Submitting Jito sell bundle for ${symbol}...`);
    const result = await this.jitoExecutor.executeSwapBundle(
      swapTx,
      this.walletManager.keypair
    );

    if (!result.success) {
      logger.error(MODULE, `Sell failed: ${result.error}`);
      await this.telegramBot.sendSellResult(symbol, false, {
        bundleId: result.bundleId,
        error: result.error,
      });
      return;
    }

    // 7. Success — close position
    const solReceived = Number(freshQuote.outAmount) / 1_000_000_000;
    const solPriceUsd = await this.walletManager.getSOLPriceUSD();
    // Harga per token dalam USD (konsisten dengan entryPriceUsd calculation)
    const exitPriceUsd = position.tokensReceived > 0
      ? (solReceived * solPriceUsd) / position.tokensReceived
      : 0;

    const closedPos = this.riskManager.closePosition(position.id, exitPriceUsd);
    const pnlPct = closedPos?.pnlPct ?? 0;

    logger.info(MODULE, `✅ SELL SUCCESS: ${symbol} | BundleID: ${result.bundleId?.slice(0, 12)} | PnL: ${pnlPct.toFixed(2)}%`);
    await this.telegramBot.sendSellResult(symbol, true, {
      side: 'SELL',
      bundleId: result.bundleId,
      solReceived,
      exitPriceUsd,
      pnlPct,
      amountSol: position.amountSol,
    });
  }
}
