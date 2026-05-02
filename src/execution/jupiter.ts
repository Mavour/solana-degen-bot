// src/execution/jupiter.ts
// Jupiter v6 API - Quote & Swap transaction builder

import axios, { AxiosInstance } from 'axios';
import {
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { QuoteResult } from '../utils/types';
import { WSOL } from '../scanner/gmgn';

const MODULE = 'JUPITER';

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';
const LAMPORTS_PER_SOL = 1_000_000_000;

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  slippageBps: number;
  routePlan: unknown[];
  otherAmountThreshold: string;
}

interface JupiterSwapResponse {
  swapTransaction: string;  // Base64 encoded
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
}

export class JupiterClient {
  private client: AxiosInstance;
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
    this.client = axios.create({
      baseURL: JUPITER_QUOTE_API,
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
  }

  /**
   * Dapatkan quote untuk swap SOL -> Token
   */
  async getQuote(
    tokenMint: string,
    amountSol: number,
    slippagePct: number
  ): Promise<QuoteResult | null> {
    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
    const slippageBps = Math.floor(slippagePct * 100); // % to basis points

    try {
      logger.debug(MODULE, `Getting quote: ${amountSol} SOL -> ${tokenMint.slice(0, 8)} (${slippagePct}% slippage)`);

      const response = await this.client.get<JupiterQuoteResponse>('/quote', {
        params: {
          inputMint: WSOL,
          outputMint: tokenMint,
          amount: lamports.toString(),
          slippageBps,
          // Prefer direct routes untuk mengurangi price impact
          maxAccounts: 20,
          onlyDirectRoutes: false,
          asLegacyTransaction: false,
        },
      });

      const q = response.data;
      const priceImpact = parseFloat(q.priceImpactPct);

      logger.debug(MODULE, `Quote received`, {
        inAmount: `${amountSol} SOL`,
        outAmount: q.outAmount,
        priceImpact: `${priceImpact.toFixed(3)}%`,
        slippage: `${slippagePct}%`,
      });

      return {
        inputMint: q.inputMint,
        outputMint: q.outputMint,
        inAmount: BigInt(q.inAmount),
        outAmount: BigInt(q.outAmount),
        priceImpactPct: priceImpact,
        slippageBps,
        routePlan: q.routePlan,
        rawQuote: q,
      };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        logger.error(MODULE, `Quote API error: ${err.response?.status} ${err.response?.statusText}`);
      } else {
        logger.error(MODULE, 'Quote failed', err);
      }
      return null;
    }
  }

  /**
   * Build swap transaction (belum di-sign)
   */
  async buildSwapTransaction(
    quote: QuoteResult,
    userPublicKey: PublicKey,
    jitoTipLamports?: number
  ): Promise<VersionedTransaction | null> {
    try {
      const swapBody: Record<string, unknown> = {
        quoteResponse: quote.rawQuote,
        userPublicKey: userPublicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,  // Gas optimization
        dynamicSlippage: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: 5000000, // Max 0.005 SOL priority fee
            priorityLevel: 'high',
          },
        },
      };

      // Jika menggunakan Jito, tambahkan tip
      if (jitoTipLamports && jitoTipLamports > 0) {
        swapBody.jitoTipLamports = jitoTipLamports;
      }

      const response = await this.client.post<JupiterSwapResponse>('/swap', swapBody);

      const txBuffer = Buffer.from(response.data.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(txBuffer);

      logger.debug(MODULE, `Swap transaction built | lastValidBlock: ${response.data.lastValidBlockHeight}`);
      return transaction;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        logger.error(MODULE, `Swap build error: ${err.response?.data?.error || err.message}`);
      } else {
        logger.error(MODULE, 'Build swap tx failed', err);
      }
      return null;
    }
  }

  /**
   * Simulate transaction untuk cek price impact dan fee
   * Returns null jika simulasi gagal
   */
  async simulateTransaction(
    transaction: VersionedTransaction,
    userPublicKey: PublicKey
  ): Promise<{ success: boolean; feeSOL: number; error?: string }> {
    try {
      // Simulasi via RPC
      const sim = await this.connection.simulateTransaction(transaction, {
        commitment: 'processed',
        replaceRecentBlockhash: true,
      });

      if (sim.value.err) {
        const errStr = JSON.stringify(sim.value.err);
        logger.warn(MODULE, `Simulation failed: ${errStr}`);
        return { success: false, feeSOL: 0, error: errStr };
      }

      const fee = await this.connection.getFeeForMessage(
        transaction.message,
        'processed'
      );
      const feeSOL = (fee.value ?? 5000) / LAMPORTS_PER_SOL;

      logger.debug(MODULE, `Simulation success | Fee: ${feeSOL.toFixed(6)} SOL | Units: ${sim.value.unitsConsumed}`);
      return { success: true, feeSOL };
    } catch (err) {
      logger.error(MODULE, 'Simulation error', err);
      return { success: false, feeSOL: 0, error: String(err) };
    }
  }
}
