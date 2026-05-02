// src/utils/logger.ts
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { config } from '../config';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m',  // Cyan
  info:  '\x1b[32m',  // Green
  warn:  '\x1b[33m',  // Yellow
  error: '\x1b[31m',  // Red
};

const RESET = '\x1b[0m';

class Logger {
  private logStream: ReturnType<typeof createWriteStream> | null = null;
  private minLevel: number;

  constructor() {
    this.minLevel = LEVELS[config.logging.level as LogLevel] ?? LEVELS.info;
    this.initFileStream();
  }

  private initFileStream(): void {
    try {
      const logDir = path.dirname(config.logging.file);
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
      this.logStream = createWriteStream(config.logging.file, { flags: 'a' });
    } catch (err) {
      console.error('[LOGGER] Failed to init file stream:', err);
    }
  }

  private format(level: LogLevel, module: string, message: string, data?: unknown): string {
    const ts = new Date().toISOString();
    const dataStr = data !== undefined ? ` ${JSON.stringify(data, null, 0)}` : '';
    return `[${ts}] [${level.toUpperCase().padEnd(5)}] [${module}] ${message}${dataStr}`;
  }

  log(level: LogLevel, module: string, message: string, data?: unknown): void {
    if (LEVELS[level] < this.minLevel) return;

    const plain = this.format(level, module, message, data);
    const colored = `${COLORS[level]}${plain}${RESET}`;

    console.log(colored);
    this.logStream?.write(plain + '\n');
  }

  debug(module: string, msg: string, data?: unknown) { this.log('debug', module, msg, data); }
  info(module: string, msg: string, data?: unknown)  { this.log('info',  module, msg, data); }
  warn(module: string, msg: string, data?: unknown)  { this.log('warn',  module, msg, data); }
  error(module: string, msg: string, data?: unknown) { this.log('error', module, msg, data); }
}

export const logger = new Logger();
