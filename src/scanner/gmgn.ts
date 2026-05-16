// src/scanner/gmgn.ts
// GMGN.ai Scanner dengan endpoints yang lebih robust

import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { TokenInfo, OHLCVCandle } from '../utils/types';

const MODULE = 'GMGN';

// WSOL mint address
export const WSOL = 'So11111111111111111111111111111111111111112';

// Browser-like headers untuk bypass bot detection
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getBrowserHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://gmgn.ai/?chain=sol',
    'Origin': 'https://gmgn.ai',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
  };

  // GMGN API Key — coba semua format header yang umum
  if (config.gmgn.apiKey) {
    // GMGN's documented API key header is x-route-key.
    headers['Authorization'] = `Bearer ${config.gmgn.apiKey}`;
    headers['x-route-key'] = config.gmgn.apiKey;
    headers['X-API-Key'] = config.gmgn.apiKey;
    headers['x-api-key'] = config.gmgn.apiKey;
    headers['API-Key'] = config.gmgn.apiKey;
    headers['api-key'] = config.gmgn.apiKey;
    headers['Api-Key'] = config.gmgn.apiKey;
  }

  // Session cookie fallback (kalau nggak punya API key)
  if (config.gmgn.sessionCookie) {
    headers['Cookie'] = config.gmgn.sessionCookie;
  }

  return headers;
}

export class GMGNScanner {
  private client: AxiosInstance;

  constructor() {
    const axiosConfig: Record<string, any> = {
      baseURL: 'https://gmgn.ai',
      timeout: 20000,
      headers: getBrowserHeaders(),
      withCredentials: true,
    };

    // Proxy support (bypass IP block)
    if (config.proxy.url) {
      try {
        const proxyUrl = new URL(config.proxy.url);
        axiosConfig.proxy = {
          protocol: proxyUrl.protocol.replace(':', ''),
          host: proxyUrl.hostname,
          port: parseInt(proxyUrl.port || (proxyUrl.protocol === 'https:' ? '443' : '80')),
          auth: proxyUrl.username ? { username: proxyUrl.username, password: proxyUrl.password } : undefined,
        };
        logger.info(MODULE, `Using proxy: ${proxyUrl.hostname}:${proxyUrl.port}`);
      } catch {
        logger.warn(MODULE, `Invalid PROXY_URL format: ${config.proxy.url}`);
      }
    }

    this.client = axios.create(axiosConfig);

    // Cookie jar sederhana
    const cookieJar: string[] = [];

    this.client.interceptors.request.use((req) => {
      if (config.gmgn.apiKey && (process.env.GMGN_API_KEY_QUERY_PARAM ?? 'false') === 'true') {
        req.params = req.params || {};
        req.params.api_key = config.gmgn.apiKey;
        const url = req.url ?? '';
        const fullUrl = `${req.baseURL}${url}`;
        logger.debug(MODULE, `GMGN request: ${fullUrl.split('?')[0]}?api_key=***`);
      }
      return req;
    });

    this.client.interceptors.response.use(
      (res) => {
        // Simpan cookie dari response untuk request berikutnya
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          cookieJar.push(...setCookie);
          this.client.defaults.headers['Cookie'] = cookieJar.join('; ');
        }
        return res;
      },
      (err) => {
        const status = err.response?.status;
        const url = err.config?.url;
        if (status === 403) {
          const hasApiKey = !!config.gmgn.apiKey;
          const hasCookie = !!config.gmgn.sessionCookie;
          const hasProxy = !!config.proxy.url;
          if (!hasApiKey && !hasCookie && !hasProxy) {
            logger.warn(MODULE, `GMGN 403 - IP blocked. Tambahkan GMGN_API_KEY, GMGN_SESSION_COOKIE, atau PROXY_URL di .env`);
        } else if (hasApiKey) {
          logger.warn(MODULE, `GMGN 403 - request ditolak. API key terbaca; cek apakah key punya akses endpoint data/rank, IP whitelist, atau butuh GMGN_SESSION_COOKIE.`);
          } else if (hasCookie) {
            logger.warn(MODULE, `GMGN 403 - Session cookie expired. Coba update GMGN_SESSION_COOKIE.`);
          } else {
            logger.warn(MODULE, `GMGN 403 - Proxy masih kena block. Coba ganti PROXY_URL.`);
          }
        } else {
          logger.warn(MODULE, `Request failed: ${url} (HTTP ${status})`);
        }
        return Promise.reject(err);
      }
    );
  }

  /**
   * Fetch trending tokens — coba beberapa endpoint format GMGN
   */
  async fetchTrending(): Promise<any[]> {
    // GMGN punya beberapa endpoint format, coba satu per satu
    const endpoints = [
      { url: '/defi/quotation/v1/rank/sol/swaps/1h', params: { orderby: 'swaps', direction: 'desc', limit: 50 } },
      { url: '/api/v1/rank/sol/swaps/1h', params: { orderby: 'swaps', direction: 'desc', limit: 50 } },
      { url: '/defi/quotation/v1/rank/sol/swaps/5m', params: { orderby: 'swaps', direction: 'desc', limit: 50 } },
    ];

    for (const ep of endpoints) {
      try {
        const res = await this.client.get(ep.url, { params: ep.params });
        const data = res.data?.data?.rank ?? res.data?.rank ?? [];
        if (Array.isArray(data) && data.length > 0) {
          logger.info(MODULE, `Trending OK via ${ep.url}: ${data.length} tokens`);
          return data;
        }
      } catch (err) {
        logger.debug(MODULE, `Endpoint ${ep.url} failed`);
      }
      await sleep(500);
    }

    logger.warn(MODULE, 'All GMGN trending endpoints failed');
    return [];
  }

  /**
   * Filter tokens sesuai kriteria Obicle + strict degen filters
   */
  filterTokens(tokens: any[]): any[] {
    const now = Math.floor(Date.now() / 1000);
    const results: any[] = [];

    for (const token of tokens) {
      const ageSeconds = now - (token.open_timestamp || token.created_timestamp || 0);
      const mcap = token.market_cap || token.usd_market_cap || 0;
      const liquidity = token.liquidity || token.pool_liquidity_usd || 0;
      const volume = token.volume || token.volume_1h || token.swaps_1h || 0;
      const symbol = token.symbol || token.token_symbol || 'UNKNOWN';
      const priceChange1h = token.price_change_percent1h || token.price_change_1h || 0;
      const priceChange24h = token.price_change_percent24h || token.price_change_24h || 0;
      const holders = token.holder_count || token.holders || 0;

      // Extract fee data — Obicle filter: fee / mcap >= 10%
      const feeSol = token.total_fee_sol ?? token.fee_sol ?? token.total_fee ?? token.fee ?? 0;
      const minFeeSol = mcap > 0 ? (mcap / 1000) * config.trading.minFeeSolPer1kMcap : 0;

      // Age > 1 jam
      if (ageSeconds < config.trading.minTokenAgeSeconds) {
        logger.debug(MODULE, `Skip ${symbol}: too young (${Math.floor(ageSeconds/60)}m)`);
        continue;
      }

      // MCap filter: min $150K — max $5M (default)
      const minMcap = mcap > 0 ? config.trading.minMcapUsd : 100000;
      if (mcap > 0 && mcap < minMcap) {
        logger.debug(MODULE, `Skip ${symbol}: mcap $${(mcap/1000).toFixed(0)}K < $${(minMcap/1000).toFixed(0)}K`);
        continue;
      }
      if (mcap > 0 && mcap > config.trading.maxMcapUsd) {
        logger.debug(MODULE, `Skip ${symbol}: mcap $${(mcap/1000000).toFixed(2)}M > max $${(config.trading.maxMcapUsd/1000000).toFixed(0)}M`);
        continue;
      }

      // ── STRICT DEGEN FILTERS ──

      // Minimum holders — avoid dead/rug tokens
      if (holders > 0 && holders < 80) {
        logger.debug(MODULE, `Skip ${symbol}: too few holders (${holders})`);
        continue;
      }

      // Avoid massive 1h dumps (>20% in 1h = likely rug or panic)
      if (priceChange1h < -20) {
        logger.debug(MODULE, `Skip ${symbol}: 1h dump ${priceChange1h.toFixed(1)}%`);
        continue;
      }

      // Avoid tokens dumping hard in 24h
      if (priceChange24h < -40) {
        logger.debug(MODULE, `Skip ${symbol}: 24h dump ${priceChange24h.toFixed(1)}%`);
        continue;
      }

      // Avoid already pumped >300% in 1h (FOMO top)
      if (priceChange1h > 300) {
        logger.debug(MODULE, `Skip ${symbol}: already pumped ${priceChange1h.toFixed(0)}% in 1h`);
        continue;
      }

      // Obicle fee filter
      if (minFeeSol > 0 && feeSol < minFeeSol) {
        logger.debug(MODULE, `Skip ${symbol}: fee ${feeSol.toFixed(2)} SOL < min ${minFeeSol.toFixed(2)} SOL`);
        continue;
      }

      // Liquidity minimal $5K (raised from $3K)
      if (liquidity > 0 && liquidity < 5000) {
        logger.debug(MODULE, `Skip ${symbol}: liquidity $${liquidity.toFixed(0)} too low`);
        continue;
      }

      // Volume 24h minimal
      const volume24h = token.volume_24h || token.volume || 0;
      if (volume24h > 0 && volume24h < config.trading.minVolumeUsd24h) {
        logger.debug(MODULE, `Skip ${symbol}: volume24h $${(volume24h/1000).toFixed(0)}K < min $${(config.trading.minVolumeUsd24h/1000).toFixed(0)}K`);
        continue;
      }

      results.push(token);
    }

    logger.info(MODULE, `Filter: ${results.length}/${tokens.length} tokens passed`);
    return results;
  }

  /**
   * Fetch OHLCV — coba beberapa format endpoint
   */
  async fetchOHLCV(tokenAddress: string, limit: number = 200): Promise<OHLCVCandle[]> {
    const endpoints = [
      `/api/v1/token_kline/sol/${tokenAddress}`,
      `/defi/quotation/v1/token_kline/sol/${tokenAddress}`,
    ];

    for (const url of endpoints) {
      try {
        const res = await this.client.get(url, {
          params: { resolution: '5', limit },
        });

        const list = res.data?.data?.list ?? res.data?.list ?? [];
        if (!Array.isArray(list) || list.length === 0) continue;

        const candles: OHLCVCandle[] = list.map((c: any) => ({
          timestamp: Number(c.timestamp || c.time || 0),
          open:  parseFloat(c.open  || c.o || 0),
          high:  parseFloat(c.high  || c.h || 0),
          low:   parseFloat(c.low   || c.l || 0),
          close: parseFloat(c.close || c.c || 0),
          volume: parseFloat(c.volume || c.v || 0),
        })).filter((c: OHLCVCandle) => c.close > 0);

        logger.debug(MODULE, `OHLCV ${tokenAddress.slice(0,8)}: ${candles.length} candles`);
        return candles;
      } catch {
        // try next endpoint
      }
    }

    return [];
  }

  /**
   * Fetch token detail
   */
  async fetchTokenDetail(tokenAddress: string): Promise<TokenInfo | null> {
    try {
      const [detailRes, ohlcv] = await Promise.allSettled([
        this.client.get(`/api/v1/token_info/sol/${tokenAddress}`),
        this.fetchOHLCV(tokenAddress, 200),
      ]);

      const ohlcvData = ohlcv.status === 'fulfilled' ? ohlcv.value : [];

      if (detailRes.status === 'fulfilled') {
        const t = detailRes.value.data?.data?.token ?? detailRes.value.data?.token;
        if (t) {
          const now = Math.floor(Date.now() / 1000);
          return {
            address: tokenAddress,
            symbol: t.symbol || 'UNKNOWN',
            name: t.name || 'Unknown',
            mcapUsd: t.market_cap || t.usd_market_cap || 0,
            liquidityUsd: t.liquidity || 0,
            volumeUsd24h: t.volume_24h || t.volume || 0,
            globalFeeSol: t.total_fee_sol ?? t.fee_sol ?? t.total_fee ?? t.fee ?? 0,
            ageSeconds: now - (t.open_timestamp || t.created_timestamp || now - 7200),
            priceUsd: t.price || t.usd_price || 0,
            priceChangePct1h: t.price_change_percent1h || t.price_change_1h || 0,
            holders: t.holder_count || t.holders || 0,
            ohlcv: ohlcvData,
            ohlcvSource: 'real',
          };
        }
      }

      // Fallback: minimal token info tanpa detail
      if (ohlcvData.length > 0) {
        logger.debug(MODULE, `Using OHLCV-only data for ${tokenAddress.slice(0,8)}`);
        return {
          address: tokenAddress,
          symbol: 'UNKNOWN',
          name: 'Unknown',
          mcapUsd: 0,
          liquidityUsd: 0,
          volumeUsd24h: 0,
          globalFeeSol: 0,
          ageSeconds: 7200,
          priceUsd: ohlcvData[ohlcvData.length - 1]?.close ?? 0,
          priceChangePct1h: 0,
          holders: 0,
          ohlcv: ohlcvData,
          ohlcvSource: 'real',
        };
      }

      return null;
    } catch (err) {
      logger.warn(MODULE, `fetchTokenDetail failed: ${tokenAddress.slice(0,8)}`);
      return null;
    }
  }

  /**
   * Main scan
   */
  async scan(): Promise<TokenInfo[]> {
    logger.info(MODULE, '🔍 GMGN scan starting...');

    const trending = await this.fetchTrending();
    if (!trending.length) {
      logger.warn(MODULE, 'GMGN trending empty — will trigger fallback');
      throw new Error('GMGN trending returned 0 tokens');
    }

    const filtered = this.filterTokens(trending);
    if (!filtered.length) return [];

    const enriched: TokenInfo[] = [];

    for (const token of filtered.slice(0, 5)) {
      const addr = token.address || token.token_address;
      if (!addr) continue;

      const detail = await this.fetchTokenDetail(addr);
      if (detail) {
        // Merge filter data kalau detail kurang lengkap
        if (!detail.mcapUsd && (token.market_cap || token.usd_market_cap)) {
          detail.mcapUsd = token.market_cap || token.usd_market_cap;
        }
        if (!detail.symbol || detail.symbol === 'UNKNOWN') {
          detail.symbol = token.symbol || token.token_symbol || 'UNKNOWN';
        }
        enriched.push(detail);
      }

      await sleep(2500); // GMGN rate limit safe zone
    }

    logger.info(MODULE, `GMGN scan done: ${enriched.length} tokens enriched`);
    return enriched;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
