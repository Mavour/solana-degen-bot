// src/config/index.ts
// Environment config + runtime override via settings.json (Telegram /settings)

import dotenv from 'dotenv';
import path from 'path';
import { writeFileSync, readFileSync, existsSync } from 'fs';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`[CONFIG] Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return (value !== undefined && value.trim() !== '') ? value : fallback;
}

// Free public RPC endpoints — rotated for rate-limit resilience
export const FREE_RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-mainnet.rpc.extrnode.com',
  'https://rpc.ankr.com/solana',
] as const;

// Settings file path
const SETTINGS_FILE = path.resolve(process.cwd(), 'data/settings.json');

export interface RuntimeSettings {
  maxTradeSol?: number;
  slippageMinPct?: number;
  slippageMaxPct?: number;
  maxPriceImpactPct?: number;
  minVolumeUsd24h?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  scanIntervalSeconds?: number;
  monitorIntervalSeconds?: number;
  dryRun?: boolean;
}

function loadSettings(): RuntimeSettings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const raw = readFileSync(SETTINGS_FILE, 'utf-8');
      return JSON.parse(raw) as RuntimeSettings;
    }
  } catch {
    // Ignore errors
  }
  return {};
}

function saveSettings(settings: RuntimeSettings): void {
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch {
    // Ignore errors
  }
}

// Mutable config — bisa di-override runtime via /settings di Telegram
export let config = buildConfig();

function buildConfig() {
  // Load dari .env
  const base = {
    wallet: {
      privateKey: requireEnv('WALLET_PRIVATE_KEY'),
    },
    rpc: {
      url: optionalEnv('SOLANA_RPC_URL', FREE_RPC_ENDPOINTS[0]),
      wsUrl: optionalEnv('SOLANA_WS_URL', FREE_RPC_ENDPOINTS[0].replace('https', 'wss')),
      fallbackUrls: FREE_RPC_ENDPOINTS.slice(1),
    },
    jito: {
      blockEngineUrl: optionalEnv('JITO_BLOCK_ENGINE_URL', 'https://mainnet.block-engine.jito.wtf'),
      tipAmount: parseFloat(optionalEnv('JITO_TIP_AMOUNT', '0.0001')),
    },
    telegram: {
      botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
      chatId: requireEnv('TELEGRAM_CHAT_ID'),
    },
    gmgn: {
      baseUrl: optionalEnv('GMGN_BASE_URL', 'https://gmgn.ai'),
      apiKey: optionalEnv('GMGN_API_KEY', ''),
      sessionCookie: optionalEnv('GMGN_SESSION_COOKIE', ''),
    },
    trading: {
      maxTradeSol: parseFloat(optionalEnv('MAX_TRADE_SOL', '0.1')),
      minMcapUsd: parseFloat(optionalEnv('MIN_MCAP_USD', '150000')),
      minTokenAgeSeconds: parseInt(optionalEnv('MIN_TOKEN_AGE_SECONDS', '3600')),
      maxPriceImpactPct: parseFloat(optionalEnv('MAX_PRICE_IMPACT_PCT', '2.0')),
      slippageMinPct: parseFloat(optionalEnv('SLIPPAGE_MIN_PCT', '0.5')),
      slippageMaxPct: parseFloat(optionalEnv('SLIPPAGE_MAX_PCT', '3.0')),
      maxMcapUsd: parseFloat(optionalEnv('MAX_MCAP_USD', '5000000')),
      minFeeSolPer1kMcap: parseFloat(optionalEnv('MIN_FEE_SOL_PER_1K_MCAP', '0.1')),
      // Minimum volume 24h — koin sepi = susah jual = slippage besar
      minVolumeUsd24h: parseFloat(optionalEnv('MIN_VOLUME_USD_24H', '50000')),
    },
    scanning: {
      intervalSeconds: parseInt(optionalEnv('SCAN_INTERVAL_SECONDS', '180')),
    },
    monitor: {
      intervalSeconds: parseInt(optionalEnv('MONITOR_INTERVAL_SECONDS', '120')),
    },
    proxy: {
      url: optionalEnv('PROXY_URL', ''),
    },
    risk: {
      maxOpenPositions: parseInt(optionalEnv('MAX_OPEN_POSITIONS', '3')),
      stopLossPct: parseFloat(optionalEnv('STOP_LOSS_PCT', '8')),
      takeProfitPct: parseFloat(optionalEnv('TAKE_PROFIT_PCT', '50')),
    },
    dryRun: optionalEnv('DRY_RUN', 'false') === 'true',
    logging: {
      level: optionalEnv('LOG_LEVEL', 'info'),
      file: optionalEnv('LOG_FILE', 'logs/bot.log'),
    },
  };

  // Override dengan settings.json kalau ada
  const runtime = loadSettings();
  applyToConfig(base, runtime);

  return base;
}

function applyToConfig(base: any, runtime: RuntimeSettings) {
  if (runtime.maxTradeSol !== undefined) base.trading.maxTradeSol = runtime.maxTradeSol;
  if (runtime.slippageMinPct !== undefined) base.trading.slippageMinPct = runtime.slippageMinPct;
  if (runtime.slippageMaxPct !== undefined) base.trading.slippageMaxPct = runtime.slippageMaxPct;
  if (runtime.maxPriceImpactPct !== undefined) base.trading.maxPriceImpactPct = runtime.maxPriceImpactPct;
  if (runtime.minVolumeUsd24h !== undefined) base.trading.minVolumeUsd24h = runtime.minVolumeUsd24h;
  if (runtime.stopLossPct !== undefined) base.risk.stopLossPct = runtime.stopLossPct;
  if (runtime.takeProfitPct !== undefined) base.risk.takeProfitPct = runtime.takeProfitPct;
  if (runtime.scanIntervalSeconds !== undefined) base.scanning.intervalSeconds = runtime.scanIntervalSeconds;
  if (runtime.monitorIntervalSeconds !== undefined) base.monitor.intervalSeconds = runtime.monitorIntervalSeconds;
  if (runtime.dryRun !== undefined) base.dryRun = runtime.dryRun;
}

/**
 * Apply new runtime settings dari Telegram /settings.
 * Returns array of keys yang butuh restart pm2.
 */
export function applyRuntimeSettings(settings: Partial<RuntimeSettings>): string[] {
  const needsRestart: string[] = [];

  // Cek apakah ada perubahan yang butuh restart
  if (settings.scanIntervalSeconds !== undefined && settings.scanIntervalSeconds !== config.scanning.intervalSeconds) {
    needsRestart.push('scan interval');
  }
  if (settings.monitorIntervalSeconds !== undefined && settings.monitorIntervalSeconds !== config.monitor.intervalSeconds) {
    needsRestart.push('monitor interval');
  }
  if (settings.dryRun !== undefined && settings.dryRun !== config.dryRun) {
    needsRestart.push('DRY_RUN mode');
  }

  // Persist ke JSON
  const current = loadSettings();
  saveSettings({ ...current, ...settings });

  // Update config in-memory
  const newRuntime = loadSettings();
  applyToConfig(config, newRuntime);

  return needsRestart;
}

export function maskUrl(url: string): string {
  return url.replace(/(api[-_]?key=)[^&\s]+/gi, '$1***');
}
