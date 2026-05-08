// src/utils/settings.ts
// Runtime settings store — bisa diubah via Telegram, auto-persist ke JSON.
// Priority: .env (default) → settings.json (override via Telegram)

import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { logger } from './logger';

const MODULE = 'SETTINGS';
const SETTINGS_FILE = path.resolve(process.cwd(), 'data/settings.json');

export interface RuntimeSettings {
  maxTradeSol?: number;
  slippageMinPct?: number;
  slippageMaxPct?: number;
  maxPriceImpactPct?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  scanIntervalSeconds?: number;
  monitorIntervalSeconds?: number;
  dryRun?: boolean;
}

const DEFAULT_SETTINGS: RuntimeSettings = {};

let cache: RuntimeSettings = { ...DEFAULT_SETTINGS };

function load(): RuntimeSettings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const raw = readFileSync(SETTINGS_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as RuntimeSettings;
      logger.info(MODULE, `Loaded runtime settings from ${SETTINGS_FILE}`);
      return parsed;
    }
  } catch (err) {
    logger.error(MODULE, 'Failed to load settings.json', err);
  }
  return { ...DEFAULT_SETTINGS };
}

function save(settings: RuntimeSettings): void {
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    logger.info(MODULE, 'Settings saved');
  } catch (err) {
    logger.error(MODULE, 'Failed to save settings.json', err);
  }
}

export const SettingsStore = {
  init(): void {
    cache = load();
  },

  get(): RuntimeSettings {
    return { ...cache };
  },

  getOne<K extends keyof RuntimeSettings>(key: K): RuntimeSettings[K] {
    return cache[key];
  },

  set(partial: Partial<RuntimeSettings>): void {
    cache = { ...cache, ...partial };
    save(cache);
  },

  reset(): void {
    cache = { ...DEFAULT_SETTINGS };
    save(cache);
    logger.info(MODULE, 'Settings reset to defaults');
  },
};
