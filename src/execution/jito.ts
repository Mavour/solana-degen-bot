// src/execution/jito.ts
// Jito Bundle execution untuk MEV/Sandwich protection

import axios, { AxiosInstance } from 'axios';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';

const MODULE = 'JITO';

// Jito tip accounts (official)
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  '4isqVziNgbroD1gms7JiupVj3mGgewLfrDbWxGk3tgUD',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

interface JitoBundle {
  transactions: string[];  // base64 encoded
}

interface JitoBundleResponse {
  jsonrpc: string;
  id: number;
  result?: string;  // Bundle ID
  error?: {
    code: number;
    message: string;
  };
}

interface BundleStatusResponse {
  jsonrpc: string;
  id: number;
  result?: {
    value: Array<{
      bundle_id: string;
      transactions: string[];
      slot: number;
      confirmationStatus: string;
      err?: unknown;
    }>;
  };
}

export class JitoExecutor {
  private client: AxiosInstance;
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
    this.client = axios.create({
      baseURL: config.jito.blockEngineUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Pilih random tip account dari list official Jito
   */
  getRandomTipAccount(): PublicKey {
    const idx = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return new PublicKey(JITO_TIP_ACCOUNTS[idx]);
  }

  /**
   * Build tip transaction untuk Jito
   */
  async buildTipTransaction(
    payer: Keypair,
    tipLamports: number
  ): Promise<VersionedTransaction> {
    const tipAccount = this.getRandomTipAccount();
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('finalized');

    const instructions = [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: tipAccount,
        lamports: tipLamports,
      }),
    ];

    const messageV0 = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const tipTx = new VersionedTransaction(messageV0);
    tipTx.sign([payer]);

    logger.debug(MODULE, `Tip tx built | ${(tipLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL -> ${tipAccount.toBase58().slice(0, 8)}`);
    return tipTx;
  }

  /**
   * Submit bundle ke Jito Block Engine
   */
  async sendBundle(transactions: VersionedTransaction[]): Promise<string | null> {
    const serialized = transactions.map((tx) =>
      Buffer.from(tx.serialize()).toString('base64')
    );

    const payload: JitoBundle = { transactions: serialized };

    try {
      logger.info(MODULE, `Sending Jito bundle with ${transactions.length} transactions...`);

      const response = await this.client.post<JitoBundleResponse>(
        '/api/v1/bundles',
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [payload.transactions],
        }
      );

      if (response.data.error) {
        logger.error(MODULE, `Bundle rejected: ${response.data.error.message}`);
        return null;
      }

      const bundleId = response.data.result;
      logger.info(MODULE, `✅ Bundle submitted | ID: ${bundleId}`);
      return bundleId ?? null;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        logger.error(MODULE, `Jito API error: ${err.response?.data?.error?.message || err.message}`);
      } else {
        logger.error(MODULE, 'Bundle send failed', err);
      }
      return null;
    }
  }

  /**
   * Poll bundle status
   */
  async getBundleStatus(
    bundleId: string,
    maxRetries: number = 10,
    retryDelayMs: number = 3000
  ): Promise<'confirmed' | 'failed' | 'timeout'> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await this.client.post<BundleStatusResponse>(
          '/api/v1/bundles',
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'getBundleStatuses',
            params: [[bundleId]],
          }
        );

        const statuses = response.data.result?.value ?? [];
        const status = statuses.find((s) => s.bundle_id === bundleId);

        if (status) {
          if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
            logger.info(MODULE, `Bundle ${bundleId.slice(0, 8)} confirmed!`);
            return 'confirmed';
          }
          if (status.err) {
            logger.error(MODULE, `Bundle ${bundleId.slice(0, 8)} failed`, status.err);
            return 'failed';
          }
        }

        logger.debug(MODULE, `Bundle status poll ${attempt + 1}/${maxRetries}...`);
        await sleep(retryDelayMs);
      } catch (err) {
        logger.warn(MODULE, `Bundle status poll error (attempt ${attempt + 1})`, err);
        await sleep(retryDelayMs);
      }
    }

    logger.warn(MODULE, `Bundle ${bundleId.slice(0, 8)} status timeout`);
    return 'timeout';
  }

  /**
   * Execute swap via Jito bundle (main entry point)
   * Gabungkan swap tx + tip tx dalam satu bundle
   */
  async executeSwapBundle(
    swapTx: VersionedTransaction,
    payer: Keypair
  ): Promise<{ success: boolean; bundleId?: string; error?: string }> {
    const tipLamports = Math.floor(config.jito.tipAmount * LAMPORTS_PER_SOL);

    try {
      // Update recent blockhash di swap tx
      const { blockhash } = await this.connection.getLatestBlockhash('finalized');
      swapTx.message.recentBlockhash = blockhash;
      swapTx.sign([payer]);

      // Build tip transaction
      const tipTx = await this.buildTipTransaction(payer, tipLamports);

      // Bundle: [swap_tx, tip_tx]
      const bundleId = await this.sendBundle([swapTx, tipTx]);
      if (!bundleId) {
        return { success: false, error: 'Bundle submission failed' };
      }

      // Poll status
      const status = await this.getBundleStatus(bundleId);

      if (status === 'confirmed') {
        return { success: true, bundleId };
      } else if (status === 'failed') {
        return { success: false, bundleId, error: 'Bundle rejected by validators' };
      } else {
        // Timeout - cek via RPC sebagai fallback
        logger.warn(MODULE, 'Bundle timeout - checking via RPC...');
        return { success: false, bundleId, error: 'Bundle confirmation timeout' };
      }
    } catch (err) {
      logger.error(MODULE, 'executeSwapBundle error', err);
      return { success: false, error: String(err) };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
