// scripts/get-gmgn-session.js
// ============================================================
// CARA MENDAPATKAN GMGN.AI SESSION COOKIE (Bukan API Key)
// ============================================================
// GMGN.ai tidak punya API key official.
// Yang ada adalah "session cookie" dari browser yang bisa dipakai
// untuk bypass bot detection (403 Forbidden).
//
// Langkah-langkah:
// 1. Buka https://gmgn.ai di browser Chrome (bukan VPS, tapi lokal PC)
// 2. Tekan F12 → tab Network (jaringan)
// 3. Refresh halaman (F5)
// 4. Cari request ke /defi/quotation/v1/rank/sol/swaps/1h
// 5. Klik request → tab Headers → cari "cookie" di Request Headers
// 6. Copy nilai cookie-nya (panjang, ada session_id, token, dll)
// 7. Paste ke .env kamu: GMGN_SESSION_COOKIE=...
//
// ATAU lebih gampang:
// 1. Buka gmgn.ai
// 2. F12 → tab Application → Storage → Cookies → https://gmgn.ai
// 3. Cari cookie yang namanya "session" atau "token" atau "auth"
// 4. Copy value-nya
//
// Catatan:
// - Session cookie expire dalam beberapa jam/jam (tergantung GMGN)
// - Kalau expire, ulangi langkah di atas
// - Bisa kombinasikan dengan PROXY_URL untuk hasil lebih baik
// ============================================================

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.resolve(process.cwd(), '.env');

function readEnv() {
  if (!fs.existsSync(ENV_PATH)) return '';
  return fs.readFileSync(ENV_PATH, 'utf-8');
}

function writeEnv(content) {
  fs.writeFileSync(ENV_PATH, content);
}

function updateEnv(key, value) {
  let env = readEnv();
  const regex = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  
  if (regex.test(env)) {
    env = env.replace(regex, line);
  } else {
    env += `\n${line}\n`;
  }
  
  writeEnv(env);
  console.log(`✅ ${key} updated in .env`);
}

// ============================================================
// INSTRUKSI INTERAKTIF
// ============================================================

console.log(`
╔══════════════════════════════════════════════════════════════╗
║     GMGN.AI SESSION COOKIE SETUP (Bukan API Key)            ║
╚══════════════════════════════════════════════════════════════╝

GMGN.ai tidak punya API Key official. Yang bisa dipakai adalah
SESSION COOKIE dari browser untuk bypass 403 Forbidden.

CARA MENDAPATKAN SESSION COOKIE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Buka https://gmgn.ai di Chrome (di PC lokal, BUKAN VPS)

2. Tekan F12 → Tab "Application" (atau "Storage")
   → Cookies → https://gmgn.ai

3. Cari cookie dengan nama seperti:
   • session
   • token
   • auth_token
   • gmgn_session
   • __cf_bm (Cloudflare)
   • cf_clearance (Cloudflare)

4. Copy VALUE dari cookie tersebut (panjang, random string)

5. Paste di .env kamu:
   GMGN_SESSION_COOKIE=your_session_value_here

ATAU

Pakai cara cepat via curl (ganti COOKIE_VALUE):
  curl -H "Cookie: session=COOKIE_VALUE" \
       -H "User-Agent: Mozilla/5.0..." \
       https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h

KALAU MASIH 403:
━━━━━━━━━━━━━━
• Gunakan PROXY_URL di .env (wajib residential proxy)
• Atau ganti IP VPS (restart router/VPS)
• Atau tunggu 1-2 jam (IP cooldown)

`);

// Kalau dijalankan dengan argument node scripts/get-gmgn-session.js <cookie_value>
const cookieValue = process.argv[2];
if (cookieValue) {
  updateEnv('GMGN_SESSION_COOKIE', cookieValue);
  console.log('\n🚀 Session cookie saved! Restart bot:');
  console.log('   pm2 restart solana-degen-bot');
} else {
  console.log('Usage: node scripts/get-gmgn-session.js <your_session_cookie_value>');
}
