// src/scanner/dexscreener.ts
// DexScreener API — Free fallback scanner (fixed endpoint flow)

import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { TokenInfo, OHLCVCandle } from '../utils/types';

const MODULE = 'DEXSCREENER';

// Boost profile (dari /token-boosts endpoints)
interface DSBoostProfile {
  chainId: string;
  tokenAddress: string;
  url?: string;
  description?: string;
  totalAmount?: number;
}

// Pair data (dari /tokens/v1/solana/{address})
interface DSPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  priceNative?: string;
  txns?: { m5?: any; h1?: any; h6?: any; h24?: any };
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

export class DexScreenerScanner {
  private client: AxiosInstance;
  private geckoClient: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.dexscreener.com',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DegenBot/1.0)',
        'Accept': 'application/json',
      },
    });

    this.geckoClient = axios.create({
      baseURL: 'https://api.geckoterminal.com/api/v2',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DegenBot/1.0)',
        'Accept': 'application/json;version=20230302',
      },
    });
  }

  /**
   * Step 1: Ambil token addresses dari boost endpoints
   */
  private async fetchBoostedAddresses(): Promise<string[]> {
    const endpoints = [
      '/token-boosts/top/v1',
      '/token-boosts/latest/v1',
    ];

    const addresses = new Set<string>();

    for (const ep of endpoints) {
      try {
        const res = await this.client.get(ep);
        const items: DSBoostProfile[] = Array.isArray(res.data) ? res.data : [];

        items
          .filter(item => item.chainId === 'solana' && item.tokenAddress)
          .forEach(item => addresses.add(item.tokenAddress));

        logger.debug(MODULE, `${ep}: ${items.filter(i => i.chainId === 'solana').length} Solana addresses`);
      } catch (err) {
        logger.debug(MODULE, `${ep} failed`);
      }
      await sleep(300);
    }

    logger.info(MODULE, `Got ${addresses.size} unique boosted token addresses`);
    return Array.from(addresses);
  }

  /**
   * Step 2: Fetch pair data untuk list of addresses
   */
  async fetchTokensByAddress(addresses: string[]): Promise<DSPair[]> {
    if (!addresses.length) return [];

    const chunks = chunkArray(addresses, 30);
    const results: DSPair[] = [];

    for (const chunk of chunks) {
      try {
        const res = await this.client.get(`/tokens/v1/solana/${chunk.join(',')}`);
        // Response bisa array of pairs langsung
        const pairs: DSPair[] = Array.isArray(res.data)
          ? res.data
          : (res.data?.pairs ?? []);

        results.push(...pairs);
        logger.debug(MODULE, `Fetched ${pairs.length} pairs for ${chunk.length} addresses`);
      } catch (err) {
        logger.warn(MODULE, `fetchTokensByAddress chunk failed`);
      }
      await sleep(500);
    }

    return results;
  }

  /**
   * Filter pairs — kriteria Obicle
   */
  filterPairs(pairs: DSPair[]): DSPair[] {
    const now = Date.now();
    const passed: DSPair[] = [];

    for (const pair of pairs) {
      const symbol = pair.baseToken?.symbol ?? 'UNKNOWN';

      // Harus SOL/WSOL/USDC quote
      const quoteSymbol = pair.quoteToken?.symbol ?? '';
      if (!['SOL', 'WSOL', 'USDC', 'USDT'].includes(quoteSymbol)) continue;

      // Age > threshold
      if (pair.pairCreatedAt) {
        const ageMs = now - pair.pairCreatedAt;
        if (ageMs < config.trading.minTokenAgeSeconds * 1000) {
          logger.debug(MODULE, `Skip ${symbol}: too young (${Math.floor(ageMs/60000)}m)`);
          continue;
        }
      }

      // MCap filter: min & max
      const mcap = pair.marketCap ?? pair.fdv ?? 0;
      if (mcap > 0 && mcap < config.trading.minMcapUsd) {
        logger.debug(MODULE, `Skip ${symbol}: mcap $${(mcap/1000).toFixed(0)}K < min`);
        continue;
      }
      if (mcap > 0 && mcap > config.trading.maxMcapUsd) {
        logger.debug(MODULE, `Skip ${symbol}: mcap $${(mcap/1000000).toFixed(2)}M > max $${(config.trading.maxMcapUsd/1000000).toFixed(0)}M`);
        continue;
      }

      // ── STRICT DEGEN FILTERS ──
      const priceChange1h = pair.priceChange?.h1 ?? 0;
      const priceChange24h = pair.priceChange?.h24 ?? 0;

      // Avoid massive dumps
      if (priceChange1h < -20) {
        logger.debug(MODULE, `Skip ${symbol}: 1h dump ${priceChange1h.toFixed(1)}%`);
        continue;
      }
      if (priceChange24h < -40) {
        logger.debug(MODULE, `Skip ${symbol}: 24h dump ${priceChange24h.toFixed(1)}%`);
        continue;
      }

      // Avoid already pumped >300%
      if (priceChange1h > 300) {
        logger.debug(MODULE, `Skip ${symbol}: already pumped ${priceChange1h.toFixed(0)}% in 1h`);
        continue;
      }

      // NOTE: DexScreener tidak expose fee data dalam SOL.

      // Liquidity minimal $5K (raised)
      const liq = pair.liquidity?.usd ?? 0;
      if (liq > 0 && liq < 5000) {
        logger.debug(MODULE, `Skip ${symbol}: liq $${liq.toFixed(0)} too low`);
        continue;
      }

      // Volume 24h minimal
      const vol24h = pair.volume?.h24 ?? 0;
      if (vol24h > 0 && vol24h < config.trading.minVolumeUsd24h) {
        logger.debug(MODULE, `Skip ${symbol}: vol24h $${(vol24h/1000).toFixed(0)}K < min $${(config.trading.minVolumeUsd24h/1000).toFixed(0)}K`);
        continue;
      }

      // Harus ada harga
      const price = parseFloat(pair.priceUsd ?? '0');
      if (price <= 0) continue;

      passed.push(pair);
    }

    logger.info(MODULE, `Filter: ${passed.length}/${pairs.length} pairs passed`);
    return passed;
  }

  /**
   * Build synthetic OHLCV dari price change snapshots
   */
  private buildSyntheticOHLCV(pair: DSPair, currentPrice: number): OHLCVCandle[] {
    const now  = Math.floor(Date.now() / 1000);
    const pc   = pair.priceChange ?? {};
    const vol  = pair.volume ?? {};

    const p1h  = currentPrice / (1 + ((pc.h1  ?? 0) / 100)) || currentPrice;
    const p6h  = currentPrice / (1 + ((pc.h6  ?? 0) / 100)) || currentPrice;
    const p24h = currentPrice / (1 + ((pc.h24 ?? 0) / 100)) || currentPrice;

    const anchors = [
      { ts: now - 86400, price: p24h, volPC: (vol.h24 ?? 0) / 288 },
      { ts: now - 21600, price: p6h,  volPC: (vol.h6  ?? 0) / 72  },
      { ts: now - 3600,  price: p1h,  volPC: (vol.h1  ?? 0) / 12  },
      { ts: now,         price: currentPrice, volPC: vol.m5 ?? 0 },
    ];

    const candles: OHLCVCandle[] = [];
    for (let seg = 0; seg < anchors.length - 1; seg++) {
      const s = anchors[seg], e = anchors[seg + 1];
      const steps = Math.round((e.ts - s.ts) / 300);
      if (steps <= 0) continue;
      for (let i = 0; i < steps; i++) {
        const t     = i / steps;
        const noise = 1 + (Math.random() - 0.5) * 0.004;
        const close = (s.price + (e.price - s.price) * t) * noise;
        const sp    = close * 0.002;
        candles.push({
          timestamp: s.ts + i * 300,
          open:  close - sp * 0.5,
          high:  close + sp,
          low:   close - sp,
          close,
          volume: (s.volPC + e.volPC) / 2,
        });
      }
    }
    return candles;
  }

  /**
   * Fetch real on-chain OHLCV from GeckoTerminal using the pool address.
   * This keeps DexScreener fallback usable for signals without relying on synthetic candles.
   */
  private async fetchGeckoOHLCV(poolAddress: string, limit: number = 200): Promise<OHLCVCandle[]> {
    if (!poolAddress) return [];

    try {
      const res = await this.geckoClient.get(
        `/networks/solana/pools/${poolAddress}/ohlcv/minute`,
        { params: { aggregate: 5, limit, currency: 'usd' } }
      );

      const list = res.data?.data?.attributes?.ohlcv_list;
      if (!Array.isArray(list) || list.length === 0) return [];

      const candles = list
        .map((row: any[]) => ({
          timestamp: Number(row[0] ?? 0),
          open: Number(row[1] ?? 0),
          high: Number(row[2] ?? 0),
          low: Number(row[3] ?? 0),
          close: Number(row[4] ?? 0),
          volume: Number(row[5] ?? 0),
        }))
        .filter((c: OHLCVCandle) => c.timestamp > 0 && c.close > 0)
        .sort((a: OHLCVCandle, b: OHLCVCandle) => a.timestamp - b.timestamp);

      logger.debug(MODULE, `Gecko OHLCV ${poolAddress.slice(0, 8)}: ${candles.length} candles`);
      return candles;
    } catch (err: any) {
      const status = err.response?.status ?? 'no-resp';
      logger.debug(MODULE, `Gecko OHLCV failed ${poolAddress.slice(0, 8)}: HTTP ${status}`);
      return [];
    }
  }

  /**
   * Convert DSPair → TokenInfo
   */
  async pairToTokenInfo(pair: DSPair): Promise<TokenInfo> {
    const now   = Math.floor(Date.now() / 1000);
    const price = parseFloat(pair.priceUsd ?? '0');
    const mcap  = pair.marketCap ?? pair.fdv ?? 0;
    const createdSec = pair.pairCreatedAt ? pair.pairCreatedAt / 1000 : now - 7200;
    const geckoOhlcv = await this.fetchGeckoOHLCV(pair.pairAddress, 200);
    const hasRealOhlcv = geckoOhlcv.length >= 50;

    return {
      address:      pair.baseToken.address,
      symbol:       pair.baseToken.symbol,
      name:         pair.baseToken.name,
      mcapUsd:      mcap,
      liquidityUsd: pair.liquidity?.usd ?? 0,
      volumeUsd24h: pair.volume?.h24 ?? 0,
      globalFeeSol: 0,
      ageSeconds:   now - createdSec,
      priceUsd:     price,
      priceChangePct1h: pair.priceChange?.h1 ?? 0,
      holders:      0,
      ohlcv:        hasRealOhlcv ? geckoOhlcv : this.buildSyntheticOHLCV(pair, price),
      ohlcvSource:  hasRealOhlcv ? 'real' : 'synthetic',
    };
  }

  /**
   * Main scan: boost addresses → pair data → filter → TokenInfo
   */
  async scan(): Promise<TokenInfo[]> {
    logger.info(MODULE, '🔍 DexScreener scan starting...');

    // Step 1: get addresses
    const addresses = await this.fetchBoostedAddresses();
    if (!addresses.length) {
      logger.warn(MODULE, 'No boosted addresses found');
      return [];
    }

    // Step 2: fetch pair data
    const pairs = await this.fetchTokensByAddress(addresses);
    logger.info(MODULE, `Fetched ${pairs.length} pairs for ${addresses.length} addresses`);

    if (!pairs.length) return [];

    // Step 3: filter
    const filtered = this.filterPairs(pairs);
    if (!filtered.length) return [];

    // Step 4: convert + enrich with real OHLCV when available
    const tokens: TokenInfo[] = [];
    for (const pair of filtered.slice(0, 10)) {
      tokens.push(await this.pairToTokenInfo(pair));
      await sleep(350);
    }
    const realCount = tokens.filter(t => t.ohlcvSource === 'real').length;
    const syntheticCount = tokens.filter(t => t.ohlcvSource === 'synthetic').length;
    logger.info(MODULE, `OHLCV sources: real=${realCount} synthetic=${syntheticCount}`);
    logger.info(MODULE, `DexScreener done: ${tokens.length} tokens ready`);
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
