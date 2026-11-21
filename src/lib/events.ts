// Event feed — the seam where a real event bus plugs in.
//
// Every state change emits a structured event (case_created,
// credit_proposed, credit_approved, credit_executed, pipeline_failed,
// run_failed, ...) to an append-only in-app feed. The feed is the
// contract a real bus consumes: replace the append in emitEvent() with
// a publish to Kafka / SNS / EventBridge and subscribers get the same
// event types, the same fields, the same ordering guarantees (append-only,
// one event per state change, redacted payloads — see redact.ts).
//
// Production note: the in-app feed is per-browser (localStorage) and
// per-instance on the server (server/events.py, in-memory). It proves
// the event contract; it is NOT a durable bus. The fulfilment team
// wires the bus at this seam — no agent code changes.
import { redactPII } from './redact';

export type AppEventType =
  | 'case_created' | 'customer_created'
  | 'credit_proposed' | 'credit_approved' | 'credit_executed'
  | 'plan_proposed' | 'plan_approved' | 'plan_executed'
  | 'pipeline_run' | 'pipeline_failed'
  | 'run_failed' | 'eval_run'
  | 'release_approved' | 'release_blocked';

export interface AppEvent {
  id: string;
  at: string;
  type: AppEventType;
  actor: 'agent' | 'human' | 'system';
  detail: string;
  runId?: string;
  traceId?: string;
}

export function newAppEvent(
  type: AppEventType,
  actor: 'agent' | 'human' | 'system',
  detail: string,
  opts: { runId?: string; traceId?: string } = {},
): AppEvent {
  return {
    id: `EVT-${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`,
    at: new Date().toISOString(),
    type,
    actor,
    // Event payloads are redacted: phone/email never reach the feed.
    detail: redactPII(detail),
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.traceId ? { traceId: opts.traceId } : {}),
  };
}
