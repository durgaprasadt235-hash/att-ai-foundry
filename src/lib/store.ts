import type { AppState } from './types';
import { seedState } from './seed';

const KEY = 'att-ai-foundry-v1';

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppState;
      if (parsed && Array.isArray(parsed.customers) && Array.isArray(parsed.cases)) return parsed;
    }
  } catch { /* corrupted storage: reseed below */ }
  const fresh = seedState();
  try { localStorage.setItem(KEY, JSON.stringify(fresh)); } catch { /* ignore */ }
  return fresh;
}

export function saveState(state: AppState): void {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

export function resetState(): AppState {
  const fresh = seedState();
  saveState(fresh);
  return fresh;
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`;
}

export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function fmtMs(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function fmtMin(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  return `${(ms / 60000).toFixed(2)} min`;
}
