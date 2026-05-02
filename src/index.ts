// src/index.ts
// Entry point - Solana Degen Bot by Vanguard-01

import { BotOrchestrator } from './orchestrator';
import { logger } from './utils/logger';

const MODULE = 'MAIN';

async function main(): Promise<void> {
  logger.info(MODULE, '');
  logger.info(MODULE, '╔══════════════════════════════════════╗');
  logger.info(MODULE, '║   SOLANA DEGEN BOT - VANGUARD-01     ║');
  logger.info(MODULE, '║   Strategy: Obicle Basic Trading     ║');
  logger.info(MODULE, '║   Mode: Semi-Automated + Jito MEV    ║');
  logger.info(MODULE, '╚══════════════════════════════════════╝');
  logger.info(MODULE, '');

  const bot = new BotOrchestrator();

  // ── Graceful shutdown handlers ──────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info(MODULE, `\nReceived ${signal}, shutting down gracefully...`);
    try {
      await bot.stop(signal);
      process.exit(0);
    } catch (err) {
      logger.error(MODULE, 'Error during shutdown', err);
      process.exit(1);
    }
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));   // Ctrl+C
  process.on('SIGTERM', () => shutdown('SIGTERM'));  // PM2 stop
  process.on('SIGUSR2', () => shutdown('SIGUSR2'));  // PM2 reload

  // Unhandled rejection handler
  process.on('unhandledRejection', (reason, promise) => {
    logger.error(MODULE, 'Unhandled Promise Rejection', { reason, promise });
    // Don't crash - log and continue
  });

  process.on('uncaughtException', (err) => {
    logger.error(MODULE, 'Uncaught Exception', err);
    shutdown('uncaughtException');
  });

  // ── Start ────────────────────────────────────────────────────
  try {
    await bot.start();
    logger.info(MODULE, '🟢 Bot is live. Waiting for signals...');
  } catch (err) {
    logger.error(MODULE, '❌ Fatal startup error', err);
    process.exit(1);
  }
}

main();
