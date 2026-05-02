// src/execution/wallet.ts
// Wallet management - Keypair, balance, SOL price fetch

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

const MODULE = 'WALLET';

// Cache SOL price (refresh tiap 2 menit)
let cachedSolPrice: number = 150;
let lastPriceFetch: number = 0;
const PRICE_CACHE_TTL_MS = 2 * 60 * 1000;

export class WalletManager {
  readonly keypair: Keypair;
  readonly publicKey: PublicKey;
  private connection: Connection;

  constructor(connection: Connection) {
    try {
      const secretBytes = bs58.decode(config.wallet.privateKey);
      this.keypair = Keypair.fromSecretKey(secretBytes);
      this.publicKey = this.keypair.publicKey;
      this.connection = connection;
      logger.info(MODULE, `Wallet loaded: ${this.publicKey.toBase58()}`);
    } catch (err) {
      logger.error(MODULE, 'Failed to load wallet from private key. Check WALLET_PRIVATE_KEY in .env');
      throw new Error('Invalid private key format');
    }
  }

  /**
   * Get SOL balance dalam SOL unit
   */
  async getSOLBalance(): Promise<number> {
    try {
      const lamports = await this.connection.getBalance(this.publicKey, 'confirmed');
      const sol = lamports / LAMPORTS_PER_SOL;
      logger.debug(MODULE, `Balance: ${sol.toFixed(6)} SOL`);
      return sol;
    } catch (err) {
      logger.error(MODULE, 'Failed to get balance', err);
      return 0;
    }
  }

  /**
   * Cek apakah ada cukup SOL untuk trade + fee buffer
   */
  async hasSufficientBalance(
    amountSol: number,
    feeBufferSol: number = 0.01
  ): Promise<{ sufficient: boolean; balance: number; required: number }> {
    const balance = await this.getSOLBalance();
    const required = amountSol + feeBufferSol + config.jito.tipAmount;

    return {
      sufficient: balance >= required,
      balance,
      required,
    };
  }

  /**
   * Get SOL price dalam USD (via CoinGecko simple API)
   */
  async getSOLPriceUSD(): Promise<number> {
    const now = Date.now();
    if (now - lastPriceFetch < PRICE_CACHE_TTL_MS && cachedSolPrice > 0) {
      return cachedSolPrice;
    }

    try {
      const response = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price',
        {
          params: { ids: 'solana', vs_currencies: 'usd' },
          timeout: 5000,
        }
      );
      cachedSolPrice = response.data?.solana?.usd ?? cachedSolPrice;
      lastPriceFetch = now;
      logger.debug(MODULE, `SOL price: $${cachedSolPrice}`);
    } catch {
      logger.warn(MODULE, 'Failed to fetch SOL price, using cached value');
    }

    return cachedSolPrice;
  }

  /**
   * Wallet summary untuk logging/Telegram
   */
  async getSummary(): Promise<string> {
    const balance = await this.getSOLBalance();
    const solPrice = await this.getSOLPriceUSD();
    const valueUsd = balance * solPrice;

    return (
      `💳 *Wallet*: \`${this.publicKey.toBase58().slice(0, 8)}...\`\n` +
      `💰 Balance: ${balance.toFixed(4)} SOL ($${valueUsd.toFixed(2)})\n` +
      `📊 SOL Price: $${solPrice.toFixed(2)}`
    );
  }
}
