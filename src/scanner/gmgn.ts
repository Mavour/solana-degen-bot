// src/scanner/gmgn.ts
// GMGN.ai API Scanner - Filter token berdasarkan kriteria Obicle

import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { TokenInfo, OHLCVCandle } from '../utils/types';

const MODULE = 'SCANNER';

// WSOL mint address
const WSOL = 'So11111111111111111111111111111111111111112';

interface GMGNTrendingToken {
  address: string;
  symbol: string;
  name: string;
  market_cap: number;
  liquidity: number;
  volume: number;
  open_timestamp: number;       // Unix timestamp launch
  swaps_5m: number;
  swaps_1h: number;
  price: number;
  price_change_percent1h: number;
  holder_count: number;
  // Fee related
  buy_tax?: number;
  sell_tax?: number;
}

interface GMGNOHLCVResponse {
  data: {
    list: Array<{
      timestamp: number;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }>;
  };
}

interface GMGNTokenDetailResponse {
  data: {
    token: {
      address: string;
      symbol: string;
      name: string;
      market_cap: number;
      liquidity: number;
      volume_24h: number;
      open_timestamp: number;
      price: number;
      price_change_percent1h: number;
      holder_count: number;
      swaps_24h: number;
    };
  };
}

export class GMGNScanner {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.gmgn.baseUrl,
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DegenBot/1.0)',
        'Accept': 'application/json',
        ...(config.gmgn.apiKey && { 'X-API-Key': config.gmgn.apiKey }),
      },
    });

    // Response interceptor for logging
    this.client.interceptors.response.use(
      (res) => res,
      (err) => {
        const status = err.response?.status;
        const url = err.config?.url;
        logger.warn(MODULE, `API request failed: ${url} (${status})`);
        return Promise.reject(err);
      }
    );
  }

  /**
   * Fetch trending tokens dari GMGN
   */
  async fetchTrending(period: '5m' | '1h' = '1h'): Promise<GMGNTrendingToken[]> {
    try {
      // GMGN trending endpoint - SOL chain
      const response = await this.client.get(
        `/defi/quotation/v1/rank/sol/swaps/${period}`,
        {
          params: {
            orderby: 'swaps',
            direction: 'desc',
            filters: ['renounced', 'frozen'],
            limit: 50,
          },
        }
      );

      const tokens: GMGNTrendingToken[] = response.data?.data?.rank ?? [];
      logger.info(MODULE, `Fetched ${tokens.length} trending tokens (${period})`);
      return tokens;
    } catch (err) {
      logger.error(MODULE, 'Failed to fetch trending', err);
      return [];
    }
  }

  /**
   * Filter tokens berdasarkan kriteria Obicle
   */
  filterTokens(tokens: GMGNTrendingToken[]): GMGNTrendingToken[] {
    const now = Math.floor(Date.now() / 1000);

    return tokens.filter((token) => {
      // 1. Age filter: > 1 jam
      const ageSeconds = now - (token.open_timestamp || 0);
      if (ageSeconds < config.trading.minTokenAgeSeconds) {
        logger.debug(MODULE, `Skip ${token.symbol}: too young (${Math.floor(ageSeconds / 60)}m)`);
        return false;
      }

      // 2. Mcap filter: > $150k
      if ((token.market_cap || 0) < config.trading.minMcapUsd) {
        logger.debug(MODULE, `Skip ${token.symbol}: mcap too low ($${token.market_cap?.toFixed(0)})`);
        return false;
      }

      // 3. Liquidity sanity check: minimal ada likuiditas
      if ((token.liquidity || 0) < 5000) {
        logger.debug(MODULE, `Skip ${token.symbol}: liquidity too low ($${token.liquidity})`);
        return false;
      }

      // 4. Fee integrity check: Fee vs Mcap ratio 1:10
      // swaps_1h sebagai proxy untuk global fee (volume based)
      // Konversi: minimal fee harus 1/10 dari mcap dalam SOL equivalent
      // Jika mcap $150k dan SOL ~$200, maka fee minimal = 150000/(200*10) = 75 SOL
      // Simplifikasi: volume 1h harus > mcap * 0.01 (1% turnover minimal)
      const volumeToMcapRatio = (token.volume || 0) / (token.market_cap || 1);
      if (volumeToMcapRatio < 0.005) {
        logger.debug(MODULE, `Skip ${token.symbol}: volume/mcap ratio too low (${(volumeToMcapRatio * 100).toFixed(2)}%)`);
        return false;
      }

      return true;
    });
  }

  /**
   * Fetch OHLCV data untuk analisis teknikal
   */
  async fetchOHLCV(
    tokenAddress: string,
    resolution: '1' | '5' | '15' | '60' = '5',
    limit: number = 200
  ): Promise<OHLCVCandle[]> {
    try {
      const response = await this.client.get<GMGNOHLCVResponse>(
        `/api/v1/token_kline/sol/${tokenAddress}`,
        {
          params: {
            resolution,
            limit,
          },
        }
      );

      const rawCandles = response.data?.data?.list ?? [];
      const candles: OHLCVCandle[] = rawCandles.map((c) => ({
        timestamp: c.timestamp,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: parseFloat(c.volume),
      }));

      logger.debug(MODULE, `OHLCV ${tokenAddress.slice(0, 8)}: ${candles.length} candles`);
      return candles;
    } catch (err) {
      logger.warn(MODULE, `Failed OHLCV for ${tokenAddress.slice(0, 8)}`, err);
      return [];
    }
  }

  /**
   * Fetch token detail dari GMGN
   */
  async fetchTokenDetail(tokenAddress: string): Promise<TokenInfo | null> {
    try {
      const [detailRes, ohlcv] = await Promise.all([
        this.client.get<GMGNTokenDetailResponse>(`/api/v1/token_info/sol/${tokenAddress}`),
        this.fetchOHLCV(tokenAddress, '5', 200),
      ]);

      const t = detailRes.data?.data?.token;
      if (!t) return null;

      const now = Math.floor(Date.now() / 1000);

      return {
        address: t.address,
        symbol: t.symbol || 'UNKNOWN',
        name: t.name || 'Unknown',
        mcapUsd: t.market_cap || 0,
        liquidityUsd: t.liquidity || 0,
        volumeUsd24h: t.volume_24h || 0,
        globalFeeSol: 0, // Calculated separately if needed
        ageSeconds: now - (t.open_timestamp || 0),
        priceUsd: t.price || 0,
        priceChangePct1h: t.price_change_percent1h || 0,
        holders: t.holder_count || 0,
        ohlcv,
      };
    } catch (err) {
      logger.warn(MODULE, `Failed to fetch detail for ${tokenAddress.slice(0, 8)}`);
      return null;
    }
  }

  /**
   * Main scan: fetch + filter + enrich dengan detail
   */
  async scan(): Promise<TokenInfo[]> {
    logger.info(MODULE, '🔍 Starting market scan...');

    const trending = await this.fetchTrending('1h');
    if (!trending.length) {
      logger.warn(MODULE, 'No trending tokens fetched');
      return [];
    }

    const filtered = this.filterTokens(trending);
    logger.info(MODULE, `${filtered.length}/${trending.length} tokens passed filters`);

    if (!filtered.length) return [];

    // Enrich top 5 tokens — cukup, karena kita butuh kualitas bukan kuantitas.
    // GMGN free tier aman di ~2500ms antar request.
    // fetchTokenDetail = 2 calls (detail + OHLCV), jadi total ~25 detik untuk 5 token.
    // Ini acceptable karena scan interval 3 menit.
    const enriched: TokenInfo[] = [];
    const topTokens = filtered.slice(0, 5);

    for (const token of topTokens) {
      const detail = await this.fetchTokenDetail(token.address);
      if (detail && detail.ohlcv.length >= 50) {
        enriched.push(detail);
      } else {
        const now = Math.floor(Date.now() / 1000);
        enriched.push({
          address: token.address,
          symbol: token.symbol,
          name: token.name,
          mcapUsd: token.market_cap,
          liquidityUsd: token.liquidity,
          volumeUsd24h: token.volume,
          globalFeeSol: 0,
          ageSeconds: now - (token.open_timestamp || 0),
          priceUsd: token.price,
          priceChangePct1h: token.price_change_percent1h || 0,
          holders: token.holder_count || 0,
          ohlcv: [],
        });
      }

      // GMGN rate limit safe zone: 2500ms antar token
      // fetchTokenDetail itu 2 request (info + OHLCV), delay ini untuk
      // jeda sebelum request token berikutnya agar tidak kena 429
      await sleep(2500);
    }

    logger.info(MODULE, `Scan complete. ${enriched.length} tokens enriched`);
    return enriched;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// WSOL export for other modules
export { WSOL };
