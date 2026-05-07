// src/config/index.ts
import dotenv from 'dotenv';
import path from 'path';

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
  // Treat empty string same as missing — pakai fallback
  return (value !== undefined && value.trim() !== '') ? value : fallback;
}

// Free public RPC endpoints — rotated for rate-limit resilience
// Strategy is NOT HFT (tokens >1hr old), so public RPC is sufficient for testing.
// Upgrade to Helius/QuickNode for production.
export const FREE_RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',          // Official Solana Foundation
  'https://solana-mainnet.rpc.extrnode.com',      // ExtrNode free tier
  'https://rpc.ankr.com/solana',                  // Ankr free tier
] as const;

export const config = {
  wallet: {
    privateKey: requireEnv('WALLET_PRIVATE_KEY'),
  },
  rpc: {
    // Falls back to free public RPC if not set — good enough for this strategy
    url: optionalEnv('SOLANA_RPC_URL', FREE_RPC_ENDPOINTS[0]),
    wsUrl: optionalEnv('SOLANA_WS_URL', FREE_RPC_ENDPOINTS[0].replace('https', 'wss')),
    // Free RPC fallback list (used by connection manager on 429)
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
  },
  trading: {
    maxTradeSol: parseFloat(optionalEnv('MAX_TRADE_SOL', '0.1')),
    minMcapUsd: parseFloat(optionalEnv('MIN_MCAP_USD', '150000')),
    minTokenAgeSeconds: parseInt(optionalEnv('MIN_TOKEN_AGE_SECONDS', '3600')),
    maxPriceImpactPct: parseFloat(optionalEnv('MAX_PRICE_IMPACT_PCT', '2.0')),
    slippageMinPct: parseFloat(optionalEnv('SLIPPAGE_MIN_PCT', '0.5')),
    slippageMaxPct: parseFloat(optionalEnv('SLIPPAGE_MAX_PCT', '3.0')),
    // Max market cap — degen strategy works best on micro-caps. Default $5M.
    maxMcapUsd: parseFloat(optionalEnv('MAX_MCAP_USD', '5000000')),
  },
  scanning: {
    // 180 detik (3 menit) — aman untuk GMGN free tier.
    // Argumen: token >1 jam umurnya, EMA/RSI setup butuh beberapa candle.
    // Signal valid tidak hilang dalam 60 detik. 3 menit cukup responsif.
    // Kalau pakai premium RPC + GMGN key, bisa turunkan ke 60.
    intervalSeconds: parseInt(optionalEnv('SCAN_INTERVAL_SECONDS', '180')),
  },
  risk: {
    maxOpenPositions: parseInt(optionalEnv('MAX_OPEN_POSITIONS', '3')),
    stopLossPct: parseFloat(optionalEnv('STOP_LOSS_PCT', '15')),
    takeProfitPct: parseFloat(optionalEnv('TAKE_PROFIT_PCT', '50')),
  },
  // ── Dry Run Mode ───────────────────────────────────────────
  // DRY_RUN=true → scan + signal + simulasi berjalan normal,
  // tapi TIDAK ada transaksi on-chain sama sekali.
  // Cocok untuk: validasi scanner, cek apakah signal realistis,
  // testing tanpa SOL di wallet.
  // Paper positions dicatat di memory dan bisa dicek via /positions.
  dryRun: optionalEnv('DRY_RUN', 'false') === 'true',
  logging: {
    level: optionalEnv('LOG_LEVEL', 'info'),
    file: optionalEnv('LOG_FILE', 'logs/bot.log'),
  },
} as const;

export function maskUrl(url: string): string {
  // Sembunyikan api-key dari log output
  return url.replace(/(api[-_]?key=)[^&\s]+/gi, '$1***');
}
