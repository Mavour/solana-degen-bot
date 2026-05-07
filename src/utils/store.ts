// src/utils/store.ts
// Persistent JSON store for positions and paper trades
// Auto-saves on every mutation, auto-loads on startup

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { logger } from './logger';
import { Position, PaperTrade } from './types';

const MODULE = 'STORE';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const PAPER_FILE = path.join(DATA_DIR, 'paper_trades.json');

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function safeWrite<T>(filePath: string, data: T): void {
  try {
    ensureDir();
    writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error(MODULE, `Failed to write ${path.basename(filePath)}`, err);
  }
}

function safeRead<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.error(MODULE, `Failed to read ${path.basename(filePath)}`, err);
    return null;
  }
}

export class PositionStore {
  private positions: Map<string, Position> = new Map();
  private paperTrades: Map<string, PaperTrade> = new Map();

  constructor() {
    this.loadAll();
  }

  // ── Positions ────────────────────────────────────────────────

  loadPositions(): void {
    const data = safeRead<Record<string, Position>>(POSITIONS_FILE);
    if (data) {
      this.positions = new Map(Object.entries(data));
      const open = Array.from(this.positions.values()).filter(p => p.status === 'OPEN').length;
      logger.info(MODULE, `Loaded ${this.positions.size} positions (${open} OPEN) from disk`);
    }
  }

  savePositions(): void {
    const obj = Object.fromEntries(this.positions);
    safeWrite(POSITIONS_FILE, obj);
  }

  getPositionsMap(): Map<string, Position> {
    return this.positions;
  }

  setPositionsMap(map: Map<string, Position>): void {
    this.positions = map;
    this.savePositions();
  }

  // ── Paper Trades ─────────────────────────────────────────────

  loadPaperTrades(): void {
    const data = safeRead<Record<string, PaperTrade>>(PAPER_FILE);
    if (data) {
      this.paperTrades = new Map(Object.entries(data));
      const open = Array.from(this.paperTrades.values()).filter(t => t.status === 'OPEN').length;
      logger.info(MODULE, `Loaded ${this.paperTrades.size} paper trades (${open} OPEN) from disk`);
    }
  }

  savePaperTrades(): void {
    const obj = Object.fromEntries(this.paperTrades);
    safeWrite(PAPER_FILE, obj);
  }

  getPaperTradesMap(): Map<string, PaperTrade> {
    return this.paperTrades;
  }

  setPaperTradesMap(map: Map<string, PaperTrade>): void {
    this.paperTrades = map;
    this.savePaperTrades();
  }

  // ── Combined ─────────────────────────────────────────────────

  private loadAll(): void {
    this.loadPositions();
    this.loadPaperTrades();
  }

  saveAll(): void {
    this.savePositions();
    this.savePaperTrades();
  }
}
