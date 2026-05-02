# 🤖 Solana Degen Bot — Setup & Deployment Guide

> Semi-automated meme coin scanner berbasis strategi Obicle.  
> Scan otomatis, eksekusi **manual** via Telegram. Anti-MEV via Jito.

---

## 📋 Daftar Isi

1. [Persiapan Sebelum Install](#1-persiapan-sebelum-install)
2. [Setup Lokal (Testing)](#2-setup-lokal-testing)
3. [Upload ke GitHub](#3-upload-ke-github)
4. [Deploy ke VPS Ubuntu](#4-deploy-ke-vps-ubuntu)
5. [Cara Pakai Bot](#5-cara-pakai-bot)
6. [Dry Run Mode](#6-dry-run-mode)
7. [Switch ke Live Trading](#7-switch-ke-live-trading)
8. [Perintah PM2 Sehari-hari](#8-perintah-pm2-sehari-hari)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Persiapan Sebelum Install

Kamu butuh 4 hal sebelum mulai:

### A. Wallet Solana (Private Key)
- Buat wallet baru khusus bot di [Phantom](https://phantom.app) atau [Solflare](https://solflare.com)
- **Jangan pakai wallet utama** — pisahkan wallet bot
- Export private key dalam format **base58** (string panjang ~88 karakter)
- Untuk dry run: wallet boleh kosong. Untuk live: isi minimal 0.5 SOL

### B. Telegram Bot Token
1. Buka Telegram, cari **@BotFather**
2. Kirim `/newbot`
3. Ikuti instruksi, masukkan nama dan username bot
4. Salin **token** yang diberikan (format: `1234567890:ABCdef...`)

### C. Telegram Chat ID (ID kamu)
1. Buka Telegram, cari **@userinfobot**
2. Kirim `/start`
3. Salin angka **Id** yang muncul (contoh: `987654321`)

### D. Node.js v18+
- Kalau belum ada, akan diinstall otomatis oleh `setup.sh`
- Cek: `node -v` → harus `v18.x` atau lebih tinggi

---

## 2. Setup Lokal (Testing)

```bash
# 1. Extract zip yang sudah didownload
unzip solana-degen-bot-v4.zip
cd solana-degen-bot

# 2. Install dependencies
npm install

# 3. Buat file .env dari template
cp .env.example .env

# 4. Edit .env — isi minimal 3 field ini
nano .env
```

**Isi minimal di `.env` untuk mulai:**
```env
WALLET_PRIVATE_KEY=isi_private_key_base58_kamu_disini
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHI...
TELEGRAM_CHAT_ID=987654321
DRY_RUN=true
```

> Field lain seperti `SOLANA_RPC_URL`, `GMGN_BASE_URL` sudah ada default-nya.  
> Tidak perlu diisi untuk testing.

```bash
# 5. Build TypeScript
npm run build

# 6. Jalankan
npm run dev   # development (ts-node, ada hot output)
# atau
node dist/index.js  # production build
```

Kalau berhasil, terminal akan menampilkan:
```
[INFO] [MAIN]    ╔══════════════════════════════════════╗
[INFO] [MAIN]    ║   SOLANA DEGEN BOT - VANGUARD-01     ║
[INFO] [WALLET]  Wallet loaded: AbCdEf12...
[INFO] [ORCHESTRATOR] ✅ RPC OK | Slot: 123456789
[INFO] [TELEGRAM] 🤖 Telegram bot launched (polling mode)
[INFO] [ORCHESTRATOR] 🔄 Scan | 10:30:00
```

Dan Telegram kamu akan menerima pesan startup dari bot.

---

## 3. Upload ke GitHub

### A. Buat repository baru di GitHub
1. Buka [github.com/new](https://github.com/new)
2. Nama repo: `solana-degen-bot` (atau terserah)
3. Set **Private** — jangan public karena ada struktur .env
4. **Jangan** centang "Add README" atau "Add .gitignore" (sudah ada)
5. Klik **Create repository**

### B. Inisialisasi Git dan push
```bash
cd solana-degen-bot

# Init git
git init
git add .
git commit -m "feat: initial bot setup"

# Hubungkan ke GitHub (ganti USERNAME dan REPO_NAME)
git remote add origin https://github.com/USERNAME/REPO_NAME.git
git branch -M main
git push -u origin main
```

> ⚠️ **File `.env` TIDAK akan ikut** karena sudah ada di `.gitignore`.  
> Yang push hanya source code, bukan secret key kamu.

### C. Verifikasi .gitignore sudah benar
```bash
git status
# Pastikan .env tidak muncul di list
```

---

## 4. Deploy ke VPS Ubuntu

### A. Sewa VPS
Rekomendasi spec minimal untuk bot ini:
- **CPU**: 1 vCPU
- **RAM**: 1 GB
- **Storage**: 10 GB SSD
- **OS**: Ubuntu 22.04 LTS

Provider yang bagus: [Hetzner](https://hetzner.com) (murah, EU), [DigitalOcean](https://digitalocean.com), [Vultr](https://vultr.com), [Contabo](https://contabo.com) (murah).

### B. Masuk ke VPS via SSH
```bash
ssh root@IP_VPS_KAMU
# atau kalau pakai user lain:
ssh ubuntu@IP_VPS_KAMU
```

### C. Clone repo dari GitHub
```bash
# Install git kalau belum ada
apt update && apt install git -y

# Clone repo kamu
git clone https://github.com/USERNAME/REPO_NAME.git
cd REPO_NAME
```

### D. Jalankan setup script
```bash
chmod +x setup.sh
./setup.sh
```

Script ini otomatis:
- Install Node.js v20 via NVM (kalau belum ada)
- Install PM2 secara global
- `npm install` semua dependencies
- Buat folder `logs/`
- Build TypeScript ke `dist/`
- Setup PM2 startup otomatis

### E. Buat file `.env` di VPS

File `.env` tidak ikut di Git (sengaja), jadi harus dibuat manual di VPS:

```bash
# Buat dari template
cp .env.example .env

# Edit dan isi
nano .env
```

Isi `.env` di VPS (minimal):
```env
# Wallet
WALLET_PRIVATE_KEY=private_key_base58_kamu

# Telegram
TELEGRAM_BOT_TOKEN=token_dari_botfather
TELEGRAM_CHAT_ID=id_telegram_kamu

# Mode — mulai dengan dry run dulu!
DRY_RUN=true

# RPC — pakai public gratis untuk testing
# SOLANA_RPC_URL=   ← dikosongkan = pakai default public RPC

# Trading params
MAX_TRADE_SOL=0.1
STOP_LOSS_PCT=15
SCAN_INTERVAL_SECONDS=180
```

Simpan: `Ctrl+X` → `Y` → `Enter`

### F. Jalankan bot via PM2
```bash
# Start
pm2 start ecosystem.config.js

# Lihat status
pm2 status

# Lihat log realtime
pm2 logs solana-degen-bot

# Simpan konfigurasi PM2 (agar otomatis restart saat VPS reboot)
pm2 save
```

Output `pm2 status` yang normal:
```
┌─────┬──────────────────────┬─────────────┬──────┬───────────┬──────────┐
│ id  │ name                 │ namespace   │ ...  │ status    │ cpu      │
├─────┼──────────────────────┼─────────────┼──────┼───────────┼──────────┤
│ 0   │ solana-degen-bot     │ default     │ ...  │ online    │ 0%       │
└─────┴──────────────────────┴─────────────┴──────┴───────────┴──────────┘
```

---

## 5. Cara Pakai Bot

### Perintah Telegram

| Command | Fungsi |
|---------|--------|
| `/start` | Menu utama + list commands |
| `/status` | Status bot, mode (dry/live), scanner health |
| `/positions` | Lihat open positions saat ini |
| `/dryreport` | Laporan paper trading (hanya di dry run mode) |

### Alur Normal

**1. Bot scan otomatis tiap 3 menit.**  
Di log VPS akan terlihat:
```
🔄 Scan | 10:33:00
📊 [GMGN] 5 tokens
📡 1 signal(s)
🎯 BONK123 [HIGH] EMA25 RSI:18
📬 Sending Telegram alert...
```

**2. Kamu terima alert di Telegram:**
```
🎯 SIGNAL - HIGH CONFIDENCE 🔥

🪙 BONK123 (BonkToken)
📊 MCap: $287K
💧 Liquidity: $45K
🕐 Age: 2h 14m
👥 Holders: 312

📈 Indicators
• EMA25 Touch: ✅
• Stoch RSI K: 17.3
• Stoch RSI D: 15.8
• Status: 📉 BOTTOMING

💰 Trade Details
• Amount: 0.1 SOL
• Slippage: 0.8%
• Price Impact: 0.241%
• Est. Fee: 0.000024 SOL

🔗 DexScreener | GMGN

[🧪 SIMULATE (0.1 SOL paper)]  [❌ CANCEL]
```

**3. Kamu punya 5 menit untuk memutuskan:**
- Cek DexScreener/GMGN dari link di alert
- Lihat chart, pastikan masuk akal
- Klik **SIMULATE** (dry run) atau **APPROVE BUY** (live)
- Atau **CANCEL** kalau tidak yakin

**4. Bot mengirim konfirmasi:**
```
📝 [DRY RUN] PAPER TRADE SIMULATED

🪙 BONK123
💰 Size: 0.1 SOL (paper)
📊 Entry price: $0.00000234
📉 Price impact: 0.241% ✅
```

**5. Monitor exit — bot kirim alert saat RSI peak:**
```
📈 RSI PEAK — PERTIMBANGKAN JUAL

🪙 BONK123
💰 PnL: +34.2%
Stoch RSI K: 82.4 | D: 80.1
⏱ Hold: 47m

💡 Exit sekarang atau tunggu konfirmasi RSI drop
```

> **Exit adalah manual.** Bot hanya kasih alert — kamu yang jual di DexScreener/trading terminal.

---

## 6. Dry Run Mode

Gunakan ini untuk validasi scanner **sebelum deposit SOL**:

```env
DRY_RUN=true
```

Yang terjadi:
- ✅ Scan, filter, indikator, Jupiter quote — semua berjalan nyata
- ✅ Price impact dicek dari Jupiter API (data real)
- ✅ Paper position dicatat, RSI exit dimonitor
- ❌ Tidak ada transaksi on-chain
- ❌ Wallet boleh kosong

**Cek hasil paper trading:**
```
/dryreport
```

Contoh output:
```
📝 DRY RUN REPORT

🟢 Open (1)
• BONK123 | 0.1 SOL | 47m
  Entry: $0.00000234 | Impact: 0.241%
  Signal: EMA25 RSI:17 [HIGH]

📁 Closed (3)
W/L: 2W 1L | Avg PnL: +18.4%

• TOKEN1 ✅ +34.2%
• TOKEN2 ✅ +12.1%
• TOKEN3 ❌ -8.3%

📊 Signal Quality
• HIGH: 2 | MEDIUM: 1 | LOW: 0
```

Kalau setelah beberapa hari dry run hasilnya masuk akal → baru switch ke live.

---

## 7. Switch ke Live Trading

Setelah puas dengan dry run:

```bash
# Di VPS, edit .env
nano .env
```

Ubah:
```env
DRY_RUN=false
```

Deposit SOL ke wallet bot (minimal 0.5 SOL direkomendasikan untuk beberapa trade + fee buffer).

Restart bot:
```bash
pm2 restart solana-degen-bot
pm2 logs solana-degen-bot
```

Bot akan kirim pesan startup dengan badge `🟢 MODE: LIVE TRADING`.

> **Upgrade RPC untuk live trading** (opsional tapi direkomendasikan):  
> Daftar [Helius](https://helius.dev) free tier (10k req/hari) dan isi `SOLANA_RPC_URL` di `.env`.

---

## 8. Perintah PM2 Sehari-hari

```bash
# Lihat status semua proses
pm2 status

# Log realtime
pm2 logs solana-degen-bot

# Log 100 baris terakhir
pm2 logs solana-degen-bot --lines 100

# Restart bot (misal setelah edit .env)
pm2 restart solana-degen-bot

# Stop bot
pm2 stop solana-degen-bot

# Hapus dari PM2
pm2 delete solana-degen-bot

# Monitor CPU/RAM realtime
pm2 monit
```

### Update bot dari GitHub (setelah ada perubahan kode)
```bash
cd ~/REPO_NAME
git pull origin main
npm install
npm run build
pm2 restart solana-degen-bot
```

---

## 9. Troubleshooting

### Bot tidak kirim pesan ke Telegram
```bash
# Cek token dan chat ID
pm2 logs solana-degen-bot | grep TELEGRAM

# Pastikan .env sudah benar
cat .env | grep TELEGRAM
```

### Error "Invalid private key format"
- Private key harus format **base58** (string ~88 karakter)
- Bukan array angka, bukan hex
- Di Phantom: Settings → Security & Privacy → Export Private Key

### Error "Cannot connect to Solana RPC"
- Public RPC kadang down, bot akan auto-rotate ke endpoint lain
- Kalau terus error, tambahkan RPC di `.env`:
  ```env
  SOLANA_RPC_URL=https://rpc.ankr.com/solana
  ```

### GMGN selalu fallback ke DexScreener
- Normal kalau GMGN sedang maintenance atau rate limit
- Bot tetap jalan dengan DexScreener
- Cek `/status` di Telegram untuk melihat scanner health

### Signal tidak pernah muncul
Kemungkinan:
1. Filter terlalu ketat — coba turunkan `MIN_MCAP_USD` ke `100000`
2. Market sedang sepi — volume rendah
3. OHLCV tidak cukup (token terlalu baru) — sudah ada threshold 50 candles minimum

### PM2 tidak auto-start setelah reboot VPS
```bash
pm2 startup systemd -u $USER --hp $HOME
# Jalankan command yang muncul, lalu:
pm2 save
```

---

## 🔒 Keamanan

- **Jangan pernah share `.env`** — berisi private key
- **Jangan commit `.env` ke GitHub** — `.gitignore` sudah mengecualikannya
- Gunakan wallet **dedicated** khusus bot, bukan wallet utama
- Untuk paranoid: jalankan di VPS private, bukan shared hosting
- Log tidak mencetak private key sama sekali

---

*Bot ini adalah alat bantu, bukan jaminan profit. Semua keputusan beli/jual tetap di tangan kamu.*
