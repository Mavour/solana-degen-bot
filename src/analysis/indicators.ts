// src/analysis/indicators.ts
// EMA Cross + Stochastic RSI analysis - Obicle Strategy

import {
  EMA,
  StochasticRSI,
} from 'technicalindicators';
import { logger } from '../utils/logger';
import { TokenInfo, SignalResult, OHLCVCandle } from '../utils/types';

const MODULE = 'INDICATORS';

// EMA periods sesuai Obicle guide
const EMA_PERIODS = [25, 50, 100, 200] as const;
type EMAPeriod = typeof EMA_PERIODS[number];

// Stoch RSI settings: default (14, 14, 3, 3)
const STOCH_RSI_CONFIG = {
  rsiPeriod: 14,
  stochasticPeriod: 14,
  kPeriod: 3,
  dPeriod: 3,
};

// Threshold: RSI bottoming jika di bawah nilai ini
const RSI_BOTTOMING_THRESHOLD = parseInt(process.env.RSI_BOTTOMING_THRESHOLD ?? '20');
// EMA touch tolerance: harga dalam X% dari EMA dianggap "touching"
const EMA_TOUCH_TOLERANCE_PCT = parseFloat(process.env.EMA_TOUCH_TOLERANCE_PCT ?? '2.0');
// DexScreener fallback builds synthetic OHLCV. Good for price context, too noisy for entries.
const ALLOW_SYNTHETIC_OHLCV_SIGNALS = (process.env.ALLOW_SYNTHETIC_OHLCV_SIGNALS ?? 'false') === 'true';

// ── Trend Filter Config ──
// Hanya buy jika harga di atas EMA ini (trend bullish)
const TREND_EMA_PERIOD = parseInt(process.env.TREND_EMA_PERIOD ?? '50');
// Hanya buy jika EMA pendek > EMA panjang (alignment bullish)
const FAST_EMA_PERIOD = parseInt(process.env.FAST_EMA_PERIOD ?? '25');
const SLOW_EMA_PERIOD = parseInt(process.env.SLOW_EMA_PERIOD ?? '50');
// Maximum price drop 1h yang diperbolehkan (hindari catching falling knife)
const MAX_1H_DROP_PCT = parseFloat(process.env.MAX_1H_DROP_PCT ?? '-15');
// Minimum volume surge ratio (volume saat ini vs rata-rata)
const MIN_VOLUME_SURGE_RATIO = parseFloat(process.env.MIN_VOLUME_SURGE_RATIO ?? '1.2');

interface EMASeries {
  period: EMAPeriod;
  values: number[];
  currentValue: number;
}

interface StochRSIResult {
  k: number;
  d: number;
  isBottoming: boolean;
}

/**
 * Hitung semua EMA series dari OHLCV data
 */
function calculateEMAs(closes: number[]): EMASeries[] {
  const results: EMASeries[] = [];

  for (const period of EMA_PERIODS) {
    if (closes.length < period + 5) {
      logger.debug(MODULE, `Not enough data for EMA${period}: ${closes.length} candles`);
      continue;
    }

    try {
      const values = EMA.calculate({ period, values: closes });
      if (values.length === 0) continue;

      results.push({
        period,
        values,
        currentValue: values[values.length - 1],
      });
    } catch (err) {
      logger.warn(MODULE, `EMA${period} calculation failed`, err);
    }
  }

  return results;
}

/**
 * Hitung Stochastic RSI
 */
function calculateStochRSI(closes: number[]): StochRSIResult | null {
  const minRequired = STOCH_RSI_CONFIG.rsiPeriod +
    STOCH_RSI_CONFIG.stochasticPeriod +
    STOCH_RSI_CONFIG.kPeriod +
    STOCH_RSI_CONFIG.dPeriod;

  if (closes.length < minRequired) {
    logger.debug(MODULE, `Not enough data for StochRSI: ${closes.length}/${minRequired}`);
    return null;
  }

  try {
    const stochRsiValues = StochasticRSI.calculate({
      values: closes,
      rsiPeriod: STOCH_RSI_CONFIG.rsiPeriod,
      stochasticPeriod: STOCH_RSI_CONFIG.stochasticPeriod,
      kPeriod: STOCH_RSI_CONFIG.kPeriod,
      dPeriod: STOCH_RSI_CONFIG.dPeriod,
    });

    if (stochRsiValues.length === 0) return null;

    const latest = stochRsiValues[stochRsiValues.length - 1];
    const k = latest.k ?? 0;
    const d = latest.d ?? 0;

    // Cek apakah sedang bottoming:
    // K harus mulai memimpin D. Keduanya oversold tapi K masih jatuh = belum valid.
    const bothBelowThreshold = k < RSI_BOTTOMING_THRESHOLD && d < RSI_BOTTOMING_THRESHOLD;

    // Check K crossing up dari D (K dari bawah D ke atas D)
    let kCrossingUp = false;
    if (stochRsiValues.length >= 2) {
      const prev = stochRsiValues[stochRsiValues.length - 2];
      const prevK = prev.k ?? 0;
      const prevD = prev.d ?? 0;
      kCrossingUp = prevK < prevD && k >= d && k < 35; // Cross up tapi masih rendah
    }

    const isBottoming = kCrossingUp || (bothBelowThreshold && k >= d);

    return { k, d, isBottoming };
  } catch (err) {
    logger.warn(MODULE, 'StochRSI calculation failed', err);
    return null;
  }
}

/**
 * Cek apakah harga "touching" EMA dalam toleransi tertentu
 */
function isPriceTouchingEMA(
  currentPrice: number,
  emaValue: number,
  tolerancePct: number = EMA_TOUCH_TOLERANCE_PCT
): boolean {
  if (emaValue === 0) return false;
  const distancePct = Math.abs((currentPrice - emaValue) / emaValue) * 100;
  return distancePct <= tolerancePct;
}

/**
 * Hitung volatilitas (untuk dynamic slippage)
 */
export function calculateVolatility(ohlcv: OHLCVCandle[], period: number = 20): number {
  if (ohlcv.length < period) return 0.02; // default 2%

  const recentCandles = ohlcv.slice(-period);
  const returns = recentCandles.slice(1).map((c, i) =>
    Math.log(c.close / recentCandles[i].close)
  );

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  return Math.sqrt(variance);
}

/**
 * Hitung dynamic slippage berdasarkan volatilitas
 */
export function calculateDynamicSlippage(volatility: number): number {
  const { slippageMinPct, slippageMaxPct } = require('../config').config.trading;

  // Volatility < 1%: pakai min slippage
  // Volatility > 5%: pakai max slippage
  const clampedVol = Math.max(0.01, Math.min(0.05, volatility));
  const ratio = (clampedVol - 0.01) / (0.05 - 0.01);
  const slippage = slippageMinPct + ratio * (slippageMaxPct - slippageMinPct);

  return Math.round(slippage * 100) / 100; // 2 decimal places
}

/**
 * Hitung rata-rata volume dari candles
 */
function calculateAvgVolume(ohlcv: OHLCVCandle[], period: number = 20): number {
  if (ohlcv.length < period) return 0;
  const recent = ohlcv.slice(-period);
  return recent.reduce((sum, c) => sum + c.volume, 0) / recent.length;
}

/**
 * Cek volume surge: volume candle terakhir > rata-rata * ratio
 */
function hasVolumeSurge(ohlcv: OHLCVCandle[], ratio: number = MIN_VOLUME_SURGE_RATIO): boolean {
  if (ohlcv.length < 5) return true; // insufficient data, allow
  const avgVol = calculateAvgVolume(ohlcv, 20);
  const lastVol = ohlcv[ohlcv.length - 1].volume;
  if (avgVol <= 0) return true;
  return lastVol >= avgVol * ratio;
}

/**
 * Cek trend filter:
 * 1. Price di atas trend EMA (bullish trend)
 * 2. Fast EMA > Slow EMA (bullish alignment)
 * 3. Harga tidak terlalu jauh di bawah EMA200 (bukan strong downtrend)
 */
function checkTrendFilter(emas: EMASeries[], currentPrice: number): {
  passed: boolean;
  aboveTrendEma: boolean;
  emaAlignment: boolean;
  notInStrongDowntrend: boolean;
  trendScore: number; // 0-3
} {
  const trendEma = emas.find(e => e.period === TREND_EMA_PERIOD);
  const fastEma = emas.find(e => e.period === FAST_EMA_PERIOD);
  const slowEma = emas.find(e => e.period === SLOW_EMA_PERIOD);
  const ema200 = emas.find(e => e.period === 200);

  const aboveTrendEma = trendEma ? currentPrice > trendEma.currentValue : true;
  const emaAlignment = fastEma && slowEma ? fastEma.currentValue > slowEma.currentValue : true;
  // Strong downtrend: price > 20% below EMA200
  const notInStrongDowntrend = ema200
    ? currentPrice > ema200.currentValue * 0.80
    : true;

  let trendScore = 0;
  if (aboveTrendEma) trendScore++;
  if (emaAlignment) trendScore++;
  if (notInStrongDowntrend) trendScore++;

  return {
    passed: aboveTrendEma && emaAlignment && notInStrongDowntrend,
    aboveTrendEma,
    emaAlignment,
    notInStrongDowntrend,
    trendScore,
  };
}

/**
 * Main analysis: generate signal untuk satu token
 * Strategy v2: EMA bounce di UPTREND + volume confirmation
 */
export function analyzeToken(token: TokenInfo): SignalResult | null {
  if (token.ohlcvSource === 'synthetic' && !ALLOW_SYNTHETIC_OHLCV_SIGNALS) {
    logger.debug(MODULE, `${token.symbol}: rejected - synthetic OHLCV is disabled for entries`);
    return null;
  }

  if (token.ohlcv.length < 50) {
    logger.debug(MODULE, `${token.symbol}: insufficient OHLCV (${token.ohlcv.length} candles, need 50)`);
    return null;
  }

  const closes = token.ohlcv.map((c) => c.close);
  const currentPrice = closes[closes.length - 1];

  // ── Filter: hindari token yang baru crash besar ──
  if (token.priceChangePct1h < MAX_1H_DROP_PCT) {
    logger.debug(MODULE, `${token.symbol}: Rejected — 1h drop ${token.priceChangePct1h.toFixed(1)}% < threshold ${MAX_1H_DROP_PCT}%`);
    return null;
  }

  // Calculate indicators
  const emas = calculateEMAs(closes);
  const stochRsi = calculateStochRSI(closes);

  if (!stochRsi) {
    logger.debug(MODULE, `${token.symbol}: StochRSI calculation failed`);
    return null;
  }

  // ── Trend Filter ──
  const trend = checkTrendFilter(emas, currentPrice);
  if (!trend.passed) {
    logger.debug(MODULE, `${token.symbol}: No signal — trend filter failed (score:${trend.trendScore}/3)`);
    return null;
  }

  // ── Volume Confirmation ──
  const volumeOk = hasVolumeSurge(token.ohlcv);
  if (!volumeOk) {
    logger.debug(MODULE, `${token.symbol}: No signal — volume below average`);
    return null;
  }

  // Log indicator values
  logger.debug(MODULE, `${token.symbol} indicators`, {
    price: currentPrice,
    stochK: stochRsi.k.toFixed(2),
    stochD: stochRsi.d.toFixed(2),
    emas: emas.map((e) => ({ period: e.period, value: e.currentValue.toFixed(6) })),
    trendScore: trend.trendScore,
    volOk: volumeOk,
  });

  // Cari EMA yang paling dekat dengan harga saat ini
  let closestEMA: EMASeries | null = null;
  let minDistance = Infinity;

  for (const ema of emas) {
    const distancePct = Math.abs((currentPrice - ema.currentValue) / ema.currentValue) * 100;
    if (distancePct < minDistance) {
      minDistance = distancePct;
      closestEMA = ema;
    }
  }

  const emaTouch = closestEMA !== null &&
    isPriceTouchingEMA(currentPrice, closestEMA.currentValue);
  const closeRecoveredAboveEma = closestEMA !== null &&
    currentPrice >= closestEMA.currentValue * (1 - (EMA_TOUCH_TOLERANCE_PCT / 100 / 2));

  // Signal condition: EMA touch AND Stoch RSI bottoming AND trend OK AND volume OK
  if (!emaTouch || !closeRecoveredAboveEma || !stochRsi.isBottoming) {
    logger.debug(MODULE, `${token.symbol}: No signal (emaTouch=${emaTouch}, recovered=${closeRecoveredAboveEma}, rsiBottom=${stochRsi.isBottoming})`);
    return null;
  }

  // Hitung confidence dengan bobot baru
  let confidence: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
  const emaTouchedCount = emas.filter((e) =>
    isPriceTouchingEMA(currentPrice, e.currentValue, 2.0)
  ).length;

  const strongTrend = trend.trendScore >= 3;
  const strongRsi = stochRsi.k < 10 && stochRsi.d < 10;
  const strongVolume = volumeOk && token.priceChangePct1h > 0;

  if (strongRsi && emaTouchedCount >= 2 && strongTrend) {
    confidence = 'HIGH';
  } else if ((stochRsi.k < 15 && emaTouchedCount >= 1 && trend.trendScore >= 2) ||
             (strongTrend && strongVolume)) {
    confidence = 'MEDIUM';
  }

  // Skip LOW confidence signals — terlalu banyak noise
  if (confidence === 'LOW') {
    logger.debug(MODULE, `${token.symbol}: LOW confidence skipped`);
    return null;
  }

  const signal: SignalResult = {
    token,
    signalType: 'BUY',
    emaTouch,
    emaTouched: closestEMA!.period,
    stochRsiK: stochRsi.k,
    stochRsiD: stochRsi.d,
    stochRsiBottoming: stochRsi.isBottoming,
    confidence,
    timestamp: Date.now(),
  };

  logger.info(MODULE, `🎯 SIGNAL: ${token.symbol} | EMA${closestEMA!.period} | Stoch K:${stochRsi.k.toFixed(1)} D:${stochRsi.d.toFixed(1)} | Trend:${trend.trendScore}/3 | Confidence:${confidence}`);
  return signal;
}

/**
 * Batch analyze multiple tokens
 */
export function analyzeTokens(tokens: TokenInfo[]): SignalResult[] {
  const signals: SignalResult[] = [];

  for (const token of tokens) {
    try {
      const signal = analyzeToken(token);
      if (signal) signals.push(signal);
    } catch (err) {
      logger.error(MODULE, `Error analyzing ${token.symbol}`, err);
    }
  }

  // Sort by confidence: HIGH > MEDIUM > LOW
  const confidenceOrder = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  signals.sort((a, b) => confidenceOrder[b.confidence] - confidenceOrder[a.confidence]);

  return signals;
}
