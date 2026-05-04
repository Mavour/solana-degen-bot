// src/execution/simulation.ts
// Pre-execution simulation & price impact validation

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { JupiterClient } from './jupiter';
import { calculateDynamicSlippage, calculateVolatility } from '../analysis/indicators';
import { TradeParams, QuoteResult, SimulationResult, SignalResult } from '../utils/types';

const MODULE = 'SIMULATION';

export class TradeSimulator {
  private jupiterClient: JupiterClient;

  constructor(connection: Connection) {
    this.jupiterClient = new JupiterClient(connection);
  }

  /**
   * Full pre-trade check pipeline:
   * 1. Hitung dynamic slippage
   * 2. Get quote
   * 3. Validate price impact
   * 4. Simulate transaction
   */
  async preTradeCheck(
    signal: SignalResult,
    userPublicKey: PublicKey
  ): Promise<{
    approved: boolean;
    tradeParams: TradeParams;
    quoteResult: QuoteResult | null;
    simulationResult: SimulationResult;
    reason?: string;
  }> {
    const token = signal.token;

    // 1. Hitung dynamic slippage berdasarkan volatilitas
    const volatility = calculateVolatility(token.ohlcv);
    const slippagePct = calculateDynamicSlippage(volatility);
    logger.info(MODULE, `${token.symbol} | Volatility: ${(volatility * 100).toFixed(2)}% | Slippage: ${slippagePct}%`);

    const tradeParams: TradeParams = {
      tokenAddress: token.address,
      amountSol: config.trading.maxTradeSol,
      slippagePct,
      maxPriceImpactPct: config.trading.maxPriceImpactPct,
    };

    // ── DRY RUN: skip semua Jupiter/RPC calls ─────────────────
    // Tidak perlu quote asli — langsung approve dengan mock result
    if (config.dryRun) {
      logger.info(MODULE, `[DRY RUN] ${token.symbol} skipping Jupiter simulation`);
      const mockQuote: QuoteResult = {
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: token.address,
        inAmount: BigInt(Math.floor(config.trading.maxTradeSol * 1_000_000_000)),
        outAmount: BigInt(1_000_000),
        priceImpactPct: 0.1,
        slippageBps: Math.floor(slippagePct * 100),
        routePlan: [],
        rawQuote: { mock: true },
      };
      return {
        approved: true,
        tradeParams,
        quoteResult: mockQuote,
        simulationResult: {
          success: true,
          priceImpactPct: 0.1,
          estimatedFeeSOL: 0.000005,
        },
      };
    }
    // ──────────────────────────────────────────────────────────

    // 2. Liquidity check: cek apakah ada cukup likuiditas
    const estimatedPriceImpact = estimatePriceImpact(
      tradeParams.amountSol,
      token.liquidityUsd,
      token.priceUsd
    );

    if (estimatedPriceImpact > config.trading.maxPriceImpactPct) {
      const reason = `Pre-check: estimated price impact ${estimatedPriceImpact.toFixed(2)}% > max ${config.trading.maxPriceImpactPct}%`;
      logger.warn(MODULE, `${token.symbol} | ${reason}`);
      return {
        approved: false,
        tradeParams,
        quoteResult: null,
        simulationResult: { success: false, priceImpactPct: estimatedPriceImpact, estimatedFeeSOL: 0, error: reason },
        reason,
      };
    }

    // 3. Get Jupiter quote
    const quote = await this.jupiterClient.getQuote(
      token.address,
      tradeParams.amountSol,
      tradeParams.slippagePct
    );

    if (!quote) {
      const reason = 'Failed to get Jupiter quote';
      return {
        approved: false,
        tradeParams,
        quoteResult: null,
        simulationResult: { success: false, priceImpactPct: 0, estimatedFeeSOL: 0, error: reason },
        reason,
      };
    }

    // 4. Validate price impact dari Jupiter quote (lebih akurat)
    if (quote.priceImpactPct > config.trading.maxPriceImpactPct) {
      const reason = `Jupiter price impact ${quote.priceImpactPct.toFixed(2)}% exceeds max ${config.trading.maxPriceImpactPct}%`;
      logger.warn(MODULE, `${token.symbol} | ${reason}`);
      return {
        approved: false,
        tradeParams,
        quoteResult: quote,
        simulationResult: {
          success: false,
          priceImpactPct: quote.priceImpactPct,
          estimatedFeeSOL: 0,
          error: reason,
        },
        reason,
      };
    }

    // 5. Build dan simulate transaction
    const swapTx = await this.jupiterClient.buildSwapTransaction(
      quote,
      userPublicKey,
      Math.floor(config.jito.tipAmount * 1_000_000_000)
    );

    if (!swapTx) {
      const reason = 'Failed to build swap transaction';
      return {
        approved: false,
        tradeParams,
        quoteResult: quote,
        simulationResult: { success: false, priceImpactPct: quote.priceImpactPct, estimatedFeeSOL: 0, error: reason },
        reason,
      };
    }

    const simResult = await this.jupiterClient.simulateTransaction(swapTx, userPublicKey);
    const simulationResult: SimulationResult = {
      success: simResult.success,
      priceImpactPct: quote.priceImpactPct,
      estimatedFeeSOL: simResult.feeSOL,
      error: simResult.error,
    };

    if (!simResult.success) {
      const reason = `Simulation failed: ${simResult.error}`;
      logger.warn(MODULE, `${token.symbol} | ${reason}`);
      return { approved: false, tradeParams, quoteResult: quote, simulationResult, reason };
    }

    logger.info(MODULE, `✅ ${token.symbol} pre-trade check PASSED`, {
      priceImpact: `${quote.priceImpactPct.toFixed(3)}%`,
      slippage: `${slippagePct}%`,
      fee: `${simResult.feeSOL.toFixed(6)} SOL`,
    });

    return { approved: true, tradeParams, quoteResult: quote, simulationResult };
  }
}

/**
 * Estimasi kasar price impact berdasarkan trade size vs liquidity
 * Formula: impact ≈ tradeValueUSD / (liquidityUSD * 2)
 */
function estimatePriceImpact(
  amountSol: number,
  liquidityUsd: number,
  solPriceUsd: number
): number {
  if (liquidityUsd <= 0 || solPriceUsd <= 0) return 100; // Return high impact jika data tidak ada

  // Asumsi SOL price dari market (hardcode fallback jika tidak ada)
  const effectiveSolPrice = solPriceUsd > 0 ? solPriceUsd : 150;
  const tradeValueUsd = amountSol * effectiveSolPrice;

  // Constant product AMM formula approximation
  const impact = (tradeValueUsd / liquidityUsd) * 100;
  return Math.min(impact * 2, 100); // Safety multiply by 2 for conservative estimate
}
