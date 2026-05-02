// src/utils/types.ts

export interface TokenInfo {
  address: string;           // Token mint address
  symbol: string;
  name: string;
  mcapUsd: number;           // Market cap in USD
  liquidityUsd: number;      // Total liquidity USD
  volumeUsd24h: number;
  globalFeeSol: number;      // Global fee collected in SOL
  ageSeconds: number;        // Token age in seconds
  priceUsd: number;
  priceChangePct1h: number;
  holders: number;
  // OHLCV data for indicator calculation
  ohlcv: OHLCVCandle[];
}

export interface OHLCVCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SignalResult {
  token: TokenInfo;
  signalType: 'BUY';
  emaTouch: boolean;
  emaTouched: number;        // Which EMA was touched (25, 50, 100, 200)
  stochRsiK: number;
  stochRsiD: number;
  stochRsiBottoming: boolean;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  timestamp: number;
}

export interface TradeParams {
  tokenAddress: string;
  amountSol: number;
  slippagePct: number;
  maxPriceImpactPct: number;
}

export interface QuoteResult {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  priceImpactPct: number;
  slippageBps: number;
  routePlan: unknown[];
  rawQuote: unknown;
}

export interface SimulationResult {
  success: boolean;
  priceImpactPct: number;
  estimatedFeeSOL: number;
  error?: string;
}

export interface Position {
  id: string;
  tokenAddress: string;
  symbol: string;
  entryPriceUsd: number;
  amountSol: number;
  tokensReceived: number;
  entryTimestamp: number;
  txSignature: string;
  status: 'OPEN' | 'CLOSED';
}

export interface ApprovalRequest {
  id: string;
  signal: SignalResult;
  tradeParams: TradeParams;
  quoteResult: QuoteResult;
  simulationResult: SimulationResult;
  timestamp: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
}
