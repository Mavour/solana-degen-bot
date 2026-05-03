// src/scanner/dexscreener.ts
// DexScreener API v2 — Free fallback scanner
// Docs: https://docs.dexscreener.com

import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { TokenInfo, OHLCVCandle } from '../utils/types';

const MODULE = 'DEXSCREENER';

interface DSPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceNative: string;
  priceUsd: string;
  txns: { m5: any; h1: any; h6: any; h24: any };
  volume: { h24: number; h6: number; h1: number; m5: number };
  priceChange: { m5: number; h1: number; h6: number; h24: number };
  liquidity?: { usd: number; base: number; quote: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  boosts?: { active: number };
}

export class DexScreenerScanner {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.dexscreener.com',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DegenBot/1.0)',
        'Accept': 'application/json',
      },
    });
  }

  /**
   * Fetch trending/boosted Solana tokens — free endpoints
   */
  async fetchTrendingSolana(): Promise<DSPair[]> {
    const pairs: DSPair[] = [];

    // Coba beberapa endpoint gratis DS
    const endpoints = [
      '/token-boosts/top/v1',
      '/token-boosts/latest/v1',
      '/token-profiles/latest/v1',
    ];

    for (const ep of endpoints) {
      try {
        const res = await this.client.get(ep);
        // DS v2 response bisa array langsung atau {pairs:[]}
        const raw: any[] = Array.isArray(res.data)
          ? res.data
          : (res.data?.pairs ?? []);

        const solPairs = raw.filter((p: any) =>
          p.chainId === 'solana' || p.chain === 'solana'
        );

        pairs.push(...solPairs);
        logger.debug(MODULE, `${ep}: ${solPairs.length} Solana pairs`);
      } catch (err) {
        logger.debug(MODULE, `DS endpoint ${ep} failed`);
      }
      await sleep(300);
    }

    // Deduplicate by pairAddress
    const seen = new Set<string>();
    const unique = pairs.filter(p => {
      const key = p.pairAddress || p.baseToken?.address;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    logger.info(MODULE, `DexScreener: ${unique.length} unique Solana pairs`);
    return unique;
  }

  /**
   * Search token pairs by address
   */
  async fetchTokensByAddress(addresses: string[]): Promise<DSPair[]> {
    if (!addresses.length) return [];

    const chunks = chunkArray(addresses, 30);
    const results: DSPair[] = [];

    for (const chunk of chunks) {
      try {
        // DS v2 tokens endpoint
        const res = await this.client.get(`/tokens/v1/solana/${chunk.join(',')}`);
        const pairs: DSPair[] = res.data?.pairs ?? (Array.isArray(res.data) ? res.data : []);
        results.push(...pairs);
      } catch {
        // Try legacy endpoint
        try {
          const res = await this.client.get(`/dex/tokens/${chunk.join(',')}`);
          results.push(...(res.data?.pairs ?? []));
        } catch {
          logger.warn(MODULE, `fetchTokensByAddress failed for chunk`);
        }
      }
      await sleep(300);
    }

    return results;
  }

  /**
   * Filter pairs — kriteria Obicle
   */
  filterPairs(pairs: DSPair[]): DSPair[] {
    const now = Date.now();

    return pairs.filter(pair => {
      // SOL pair only
      const isSOL = ['SOL', 'WSOL', 'USDC'].includes(pair.quoteToken?.symbol ?? '');

      // Age > 1 jam
      const ageMs = pair.pairCreatedAt ? now - pair.pairCreatedAt : 0;
      if (ageMs > 0 && ageMs < config.trading.minTokenAgeSeconds * 1000) return false;

      // MCap (relaxed: $100K kalau data mcap kosong)
      const mcap = pair.marketCap ?? pair.fdv ?? 0;
      if (mcap > 0 && mcap < config.trading.minMcapUsd) return false;

      // Liquidity minimal $3K
      const liq = pair.liquidity?.usd ?? 0;
      if (liq > 0 && liq < 3000) return false;

      return true;
    });
  }

  /**
   * Build synthetic OHLCV dari price change snapshots
   * DS free tier tidak punya OHLCV endpoint
   */
  private buildSyntheticOHLCV(pair: DSPair, currentPrice: number): OHLCVCandle[] {
    const now = Math.floor(Date.now() / 1000);
    const pc = pair.priceChange ?? {};
    const vol = pair.volume ?? {};

    // Rekonstruksi harga dari % perubahan
    const p1h  = currentPrice / (1 + ((pc.h1  ?? 0) / 100)) || currentPrice;
    const p6h  = currentPrice / (1 + ((pc.h6  ?? 0) / 100)) || currentPrice;
    const p24h = currentPrice / (1 + ((pc.h24 ?? 0) / 100)) || currentPrice;

    const anchors = [
      { ts: now - 86400, price: p24h, volPerCandle: (vol.h24 ?? 0) / 288 },
      { ts: now - 21600, price: p6h,  volPerCandle: (vol.h6  ?? 0) / 72  },
      { ts: now - 3600,  price: p1h,  volPerCandle: (vol.h1  ?? 0) / 12  },
      { ts: now,         price: currentPrice, volPerCandle: (vol.m5 ?? 0) },
    ];

    const candles: OHLCVCandle[] = [];

    for (let seg = 0; seg < anchors.length - 1; seg++) {
      const start = anchors[seg];
      const end   = anchors[seg + 1];
      const steps = Math.round((end.ts - start.ts) / 300);
      if (steps <= 0) continue;

      for (let i = 0; i < steps; i++) {
        const t      = i / steps;
        const noise  = 1 + (Math.random() - 0.5) * 0.004;
        const close  = (start.price + (end.price - start.price) * t) * noise;
        const spread = close * 0.002;

        candles.push({
          timestamp: start.ts + i * 300,
          open:  close - spread * 0.5,
          high:  close + spread,
          low:   close - spread,
          close,
          volume: (start.volPerCandle + end.volPerCandle) / 2,
        });
      }
    }

    return candles;
  }

  /**
   * Convert DSPair → TokenInfo
   */
  pairToTokenInfo(pair: DSPair): TokenInfo {
    const now  = Math.floor(Date.now() / 1000);
    const price = parseFloat(pair.priceUsd ?? '0');
    const mcap  = pair.marketCap ?? pair.fdv ?? 0;
    const createdSec = pair.pairCreatedAt ? pair.pairCreatedAt / 1000 : now - 7200;

    return {
      address: pair.baseToken.address,
      symbol:  pair.baseToken.symbol,
      name:    pair.baseToken.name,
      mcapUsd: mcap,
      liquidityUsd: pair.liquidity?.usd ?? 0,
      volumeUsd24h: pair.volume?.h24 ?? 0,
      globalFeeSol: 0,
      ageSeconds: now - createdSec,
      priceUsd: price,
      priceChangePct1h: pair.priceChange?.h1 ?? 0,
      holders: 0,
      ohlcv: this.buildSyntheticOHLCV(pair, price),
    };
  }

  /**
   * Main scan
   */
  async scan(): Promise<TokenInfo[]> {
    logger.info(MODULE, '🔍 DexScreener fallback scan...');

    const pairs = await this.fetchTrendingSolana();
    if (!pairs.length) {
      logger.warn(MODULE, 'DexScreener returned no pairs');
      return [];
    }

    const filtered = this.filterPairs(pairs);
    logger.info(MODULE, `${filtered.length}/${pairs.length} pairs passed filters`);

    const tokens = filtered.slice(0, 10).map(p => this.pairToTokenInfo(p));
    logger.info(MODULE, `DexScreener done: ${tokens.length} tokens`);
    return tokens;
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
