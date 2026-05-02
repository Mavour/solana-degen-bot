// src/scanner/dexscreener.ts
// DexScreener API — Free fallback scanner when GMGN is unavailable
// Docs: https://docs.dexscreener.com/api/reference

import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { TokenInfo, OHLCVCandle } from '../utils/types';

const MODULE = 'DEXSCREENER';
const BASE_URL = 'https://api.dexscreener.com';

// ── DexScreener API response types ───────────────────────────

interface DSPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd: string;
  txns: {
    m5:  { buys: number; sells: number };
    h1:  { buys: number; sells: number };
    h6:  { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  liquidity?: {
    usd: number;
    base: number;
    quote: number;
  };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;   // Unix ms
  info?: {
    imageUrl?: string;
    websites?: Array<{ url: string }>;
    socials?: Array<{ type: string; url: string }>;
  };
  boosts?: { active: number };
}

interface DSTokenProfileResponse {
  pairs: DSPair[];
}

interface DSSearchResponse {
  pairs: DSPair[];
}

interface DSLatestTokensResponse {
  pairs: DSPair[];
}

// ── Helper ────────────────────────────────────────────────────

/**
 * Convert DexScreener pair data to OHLCV candles (synthetic from price change %)
 * DS doesn't have a free OHLCV endpoint, so we build synthetic candles from
 * multi-timeframe snapshot data. Good enough for EMA/RSI on slow-moving tokens.
 */
function buildSyntheticOHLCV(pair: DSPair, currentPriceUsd: number): OHLCVCandle[] {
  const now = Math.floor(Date.now() / 1000);
  const candles: OHLCVCandle[] = [];

  // Reconstruct approximate price path from priceChange snapshots
  // We work backwards: current → 1h ago → 6h ago → 24h ago
  const pc = pair.priceChange;
  const vol = pair.volume;

  const price1hAgo  = currentPriceUsd / (1 + (pc.h1  ?? 0) / 100);
  const price6hAgo  = currentPriceUsd / (1 + (pc.h6  ?? 0) / 100);
  const price24hAgo = currentPriceUsd / (1 + (pc.h24 ?? 0) / 100);

  // Build 5-min candles — interpolate between anchor points
  // Segments: 24h→6h (18h), 6h→1h (5h), 1h→now (1h) = 288 × 5min candles
  const anchors = [
    { ts: now - 86400, price: price24hAgo, vol: vol.h24 / 288 },
    { ts: now - 21600, price: price6hAgo,  vol: vol.h6  / 72  },
    { ts: now - 3600,  price: price1hAgo,  vol: vol.h1  / 12  },
    { ts: now,         price: currentPriceUsd, vol: vol.m5 / 1 },
  ];

  for (let seg = 0; seg < anchors.length - 1; seg++) {
    const start = anchors[seg];
    const end   = anchors[seg + 1];
    const steps = Math.round((end.ts - start.ts) / 300); // 5-min intervals

    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      // Lerp price with small noise to make indicators non-trivial
      const noise = 1 + (Math.random() - 0.5) * 0.005;
      const close = (start.price + (end.price - start.price) * t) * noise;
      const spread = close * 0.003;

      candles.push({
        timestamp: start.ts + i * 300,
        open:  close - spread * 0.5,
        high:  close + spread,
        low:   close - spread,
        close,
        volume: (start.vol + end.vol) / 2,
      });
    }
  }

  return candles;
}

// ── DexScreener Scanner class ─────────────────────────────────

export class DexScreenerScanner {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DegenBot/1.0)',
        'Accept': 'application/json',
      },
    });

    this.client.interceptors.response.use(
      (res) => res,
      (err) => {
        const status = err.response?.status;
        logger.warn(MODULE, `API error ${status}: ${err.config?.url}`);
        return Promise.reject(err);
      }
    );
  }

  /**
   * Fetch latest/boosted tokens on Solana from DexScreener
   * Endpoint: GET /token-profiles/latest/v1  (free, no auth)
   */
  async fetchLatestTokens(): Promise<DSPair[]> {
    try {
      // Latest new tokens
      const latestRes = await this.client.get<DSLatestTokensResponse>(
        '/token-profiles/latest/v1'
      );

      // Filter Solana only
      const solanaPairs = (latestRes.data?.pairs ?? []).filter(
        (p) => p.chainId === 'solana'
      );

      logger.info(MODULE, `DexScreener: ${solanaPairs.length} latest Solana pairs`);
      return solanaPairs;
    } catch (err) {
      logger.warn(MODULE, 'fetchLatestTokens failed', err);
      return [];
    }
  }

  /**
   * Search trending Solana tokens — uses the free search endpoint
   * We search by volume proxy: popular meme keywords
   */
  async fetchTrendingSolana(): Promise<DSPair[]> {
    // DexScreener boosted/trending endpoint (free)
    try {
      const [boostedRes, newTokensRes] = await Promise.allSettled([
        this.client.get<{ pairs: DSPair[] }>('/token-boosts/top/v1'),
        this.client.get<{ pairs: DSPair[] }>('/token-boosts/latest/v1'),
      ]);

      const pairs: DSPair[] = [];

      if (boostedRes.status === 'fulfilled') {
        const solPairs = (boostedRes.value.data?.pairs ?? []).filter(
          (p) => p.chainId === 'solana'
        );
        pairs.push(...solPairs);
      }

      if (newTokensRes.status === 'fulfilled') {
        const solPairs = (newTokensRes.value.data?.pairs ?? []).filter(
          (p) => p.chainId === 'solana'
        );
        pairs.push(...solPairs);
      }

      // Deduplicate by pairAddress
      const seen = new Set<string>();
      const unique = pairs.filter((p) => {
        if (seen.has(p.pairAddress)) return false;
        seen.add(p.pairAddress);
        return true;
      });

      logger.info(MODULE, `DexScreener trending: ${unique.length} unique Solana pairs`);
      return unique;
    } catch (err) {
      logger.warn(MODULE, 'fetchTrendingSolana failed', err);
      return [];
    }
  }

  /**
   * Fetch token pairs by mint address (free, up to 30 addresses per call)
   */
  async fetchTokensByAddress(addresses: string[]): Promise<DSPair[]> {
    if (!addresses.length) return [];

    // DS allows comma-separated, max 30
    const chunks = chunkArray(addresses, 30);
    const results: DSPair[] = [];

    for (const chunk of chunks) {
      try {
        const res = await this.client.get<DSTokenProfileResponse>(
          `/tokens/v1/solana/${chunk.join(',')}`
        );
        results.push(...(res.data?.pairs ?? []));
      } catch (err) {
        logger.warn(MODULE, `fetchTokensByAddress chunk failed`, err);
      }
      await sleep(200); // be polite to free API
    }

    return results;
  }

  /**
   * Filter pairs berdasarkan kriteria Obicle — same logic as GMGN scanner
   */
  filterPairs(pairs: DSPair[]): DSPair[] {
    const now = Date.now();

    return pairs.filter((pair) => {
      // Must have quote in SOL/WSOL
      const isSOLPair =
        pair.quoteToken.symbol === 'SOL' ||
        pair.quoteToken.symbol === 'WSOL' ||
        pair.quoteToken.address === 'So11111111111111111111111111111111111111112';

      if (!isSOLPair) return false;

      // Age filter: > 1 jam (pairCreatedAt is in ms)
      const ageMs = pair.pairCreatedAt ? now - pair.pairCreatedAt : 0;
      const ageSeconds = ageMs / 1000;
      if (ageSeconds < config.trading.minTokenAgeSeconds) {
        logger.debug(MODULE, `Skip ${pair.baseToken.symbol}: too young (${Math.floor(ageSeconds / 60)}m)`);
        return false;
      }

      // Mcap filter
      const mcap = pair.marketCap ?? pair.fdv ?? 0;
      if (mcap < config.trading.minMcapUsd) {
        logger.debug(MODULE, `Skip ${pair.baseToken.symbol}: mcap $${mcap?.toFixed(0)} < $${config.trading.minMcapUsd}`);
        return false;
      }

      // Liquidity filter
      const liquidity = pair.liquidity?.usd ?? 0;
      if (liquidity < 5000) {
        logger.debug(MODULE, `Skip ${pair.baseToken.symbol}: liquidity $${liquidity} too low`);
        return false;
      }

      // Volume sanity (proxy for fee integrity)
      const volumeToMcap = (pair.volume?.h24 ?? 0) / (mcap || 1);
      if (volumeToMcap < 0.005) {
        logger.debug(MODULE, `Skip ${pair.baseToken.symbol}: vol/mcap ratio ${(volumeToMcap * 100).toFixed(2)}%`);
        return false;
      }

      return true;
    });
  }

  /**
   * Convert DSPair → TokenInfo (our internal type)
   */
  pairToTokenInfo(pair: DSPair): TokenInfo {
    const now = Math.floor(Date.now() / 1000);
    const pairCreatedSec = pair.pairCreatedAt ? pair.pairCreatedAt / 1000 : now - 7200;
    const currentPrice = parseFloat(pair.priceUsd ?? '0');
    const mcap = pair.marketCap ?? pair.fdv ?? 0;

    // Build synthetic OHLCV for indicator calculation
    const ohlcv = buildSyntheticOHLCV(pair, currentPrice);

    return {
      address: pair.baseToken.address,
      symbol: pair.baseToken.symbol,
      name: pair.baseToken.name,
      mcapUsd: mcap,
      liquidityUsd: pair.liquidity?.usd ?? 0,
      volumeUsd24h: pair.volume?.h24 ?? 0,
      globalFeeSol: 0,
      ageSeconds: now - pairCreatedSec,
      priceUsd: currentPrice,
      priceChangePct1h: pair.priceChange?.h1 ?? 0,
      holders: 0,  // DS doesn't provide holder count on free tier
      ohlcv,
    };
  }

  /**
   * Main scan entry point (mirrors GMGNScanner.scan() interface)
   */
  async scan(): Promise<TokenInfo[]> {
    logger.info(MODULE, '🔍 DexScreener fallback scan starting...');

    const pairs = await this.fetchTrendingSolana();
    if (!pairs.length) {
      logger.warn(MODULE, 'DexScreener returned no pairs');
      return [];
    }

    const filtered = this.filterPairs(pairs);
    logger.info(MODULE, `${filtered.length}/${pairs.length} pairs passed filters`);

    const tokens = filtered.slice(0, 10).map((p) => this.pairToTokenInfo(p));
    logger.info(MODULE, `DexScreener scan complete: ${tokens.length} tokens ready`);
    return tokens;
  }
}

// ── Utils ─────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
