// Shared text helpers — stopwords + light stemming tokenizer.
//
// This module exists to break an import cycle: src/lib/stair.ts needs
// tokenize, and src/lib/engine.ts needs stairRetrieve. When tokenize lived
// in engine.ts, stair.ts imported engine.ts and engine.ts imported stair.ts.
// That cycle works in Vite, but it is exactly the kind of thing that breaks
// Vercel's serverless bundling (FUNCTION_INVOCATION_FAILED on every /api/*
// endpoint, 2026-11-21). Both modules now import from here; this module
// imports nothing from the app, so the graph is acyclic:
//   engine.ts -> stair.ts -> text.ts
//   engine.ts -> text.ts
export const STOPWORDS = new Set(
  'a an the is are was were what how why when where which who whom this that these those it its of for to in on at by with from as and or not no do does did can could should would i me my we you your he she they them his her their our'.split(' '),
);

export function tokenize(text: string): string[] {
  // Light stemming so "credits" matches "credit" and "charges" matches "charge".
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)).map((w) => w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
}
