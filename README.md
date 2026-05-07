# 🤖 Solana Degen Bot — VANGUARD-01
**Semi-Automated Meme Coin Trading Bot | Obicle Strategy**

---

## 🏗️ Architecture

```
solana-degen-bot/
├── src/
│   ├── config/           # Env config loader (type-safe)
│   ├── scanner/
│   │   └── gmgn.ts       # GMGN.ai API — fetch & filter trending tokens
│   ├── analysis/
│   │   └── indicators.ts # EMA Cross + Stochastic RSI signal engine
│   ├── execution/
│   │   ├── wallet.ts     # Keypair management + balance check
│   │   ├── jupiter.ts    # Jupiter v6 quote + swap tx builder
│   │   ├── jito.ts       # Jito bundle sender (MEV protection)
│   │   ├── simulation.ts # Pre-trade price impact validation
│   │   └── executor.ts   # Orchestrates execution after approval
│   ├── risk/
│   │   └── manager.ts    # Position tracking + stop-loss logic
│   ├── telegram/
│   │   └── bot.ts        # Telegraf — alerts + APPROVE/CANCEL buttons
│   ├── utils/
│   │   ├── logger.ts     # Colored console + file logger
│   │   └── types.ts      # Shared TypeScript interfaces
│   ├── orchestrator.ts   # Main coordinator + cron scheduling
│   └── index.ts          # Entry point + graceful shutdown
├── .env.example
├── ecosystem.config.js   # PM2 config
├── setup.sh              # VPS deployment script
└── tsconfig.json
```

---

## 🔄 Bot Flow

```
[CRON Every 3 min]
       │
       ▼
[GMGN Scanner]
 • Fetch trending tokens
 • Filter: age >1h, mcap >$150K, fee ratio 1:10
       │
       ▼
[Technical Analysis]
 • EMA 25/50/100/200 touch detection
 • Stochastic RSI bottoming (<20)
 • Confidence scoring: LOW/MEDIUM/HIGH
       │
       ▼
[Risk Manager]
 • Max positions check
 • Duplicate/FOMO filter
       │
       ▼
[Pre-Trade Simulation]
 • Dynamic slippage (volatility-based)
 • Jupiter quote → Price Impact check (<2%)
 • RPC transaction simulation
       │
       ▼
[Telegram Alert] ← HUMAN DECISION POINT
 • Signal details + indicators
 • DexScreener / GMGN links
 • [✅ APPROVE BUY] [❌ CANCEL]
       │
   User clicks APPROVE
       │
       ▼
[Trade Executor]
 • Re-fetch fresh quote
 • Final safety checks
 • Build Jito Bundle (swap + tip tx)
 • Submit → Poll confirmation
       │
       ▼
[Position Tracker]
 • Monitor P&L every 2 minutes
 • Stop-loss alert (default -15%)
 • Take-profit alert (default +50%)
```

---

## 🚀 Quick Start (Ubuntu VPS)

### 1. Clone & Setup
```bash
git clone https://github.com/YOUR_REPO/solana-degen-bot.git
cd solana-degen-bot
chmod +x setup.sh
./setup.sh
```

### 2. Configure .env
```bash
nano .env
```

Required fields:
```env
WALLET_PRIVATE_KEY=your_base58_private_key
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=XXX
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

### 3. Start
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 logs solana-degen-bot
```

---

## ⚙️ Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MAX_TRADE_SOL` | `0.1` | Max SOL per trade |
| `MIN_MCAP_USD` | `150000` | Minimum market cap |
| `MAX_MCAP_USD` | `5000000` | Maximum market cap (micro-cap ceiling) |
| `MIN_TOKEN_AGE_SECONDS` | `3600` | Min token age (1 hour) |
| `MAX_PRICE_IMPACT_PCT` | `2.0` | Auto-cancel if impact > this |
| `SLIPPAGE_MIN_PCT` | `0.5` | Dynamic slippage minimum |
| `SLIPPAGE_MAX_PCT` | `3.0` | Dynamic slippage maximum |
| `STOP_LOSS_PCT` | `15` | Stop-loss alert threshold |
| `MAX_OPEN_POSITIONS` | `3` | Max concurrent positions |
| `SCAN_INTERVAL_SECONDS` | `180` | Scanner frequency (3 min) |
| `JITO_TIP_AMOUNT` | `0.0001` | Jito tip in SOL |

---

## 🛡️ Safety Features

| Feature | Implementation |
|---------|---------------|
| **No Auto-Buy** | All trades require manual Telegram approval |
| **MEV Protection** | Jito Bundle — immune to sandwich attacks |
| **Price Impact Guard** | Auto-cancel if Jupiter impact > 2% |
| **Transaction Simulation** | RPC simulate before execution |
| **Dynamic Slippage** | Adapts to token volatility (0.5%–3%) |
| **Position Limits** | Max 3 open positions simultaneously |
| **Stop Loss Monitor** | Auto-alert at configurable threshold |
| **Private Key Safety** | Never logged, only in .env |
| **Balance Pre-check** | Verifies SOL before execution |

---

## 📊 Indicator Settings (Obicle Method)

| Indicator | Setting | Signal |
|-----------|---------|--------|
| EMA Cross | Short: 25, Long: 50 | Primary trend |
| EMA Cross | Short: 100, Long: 200 | Major trend |
| Stochastic RSI | 14, 14, 3, 3 (default) | Entry timing |

**Entry Condition:** Price touches any EMA **AND** Stoch RSI < 20 (bottoming)

**Exit Hint:** Manual exit when Stoch RSI peaks (>80)

---

## ⚠️ Risk Disclaimer

> "Degen adalah istilah keren main koin micin. Main micin itu **berbahaya**." — Obicle
>
> - Jangan all-in. Default bot sudah dikunci 0.1 SOL per trade.
> - Selalu ada potensi rugpull. Bot hanya membantu entry timing, bukan garansi profit.
> - Monitor posisi secara manual. Bot adalah alat bantu, bukan autopilot penuh.
> - DYOR sebelum approve setiap signal.

---

## 🔑 Get Your Keys

| Resource | URL |
|----------|-----|
| Telegram Bot Token | [@BotFather](https://t.me/BotFather) |
| Telegram Chat ID | [@userinfobot](https://t.me/userinfobot) |
| Helius RPC (Free) | [helius.dev](https://helius.dev) |
| QuickNode RPC | [quicknode.com](https://quicknode.com) |
