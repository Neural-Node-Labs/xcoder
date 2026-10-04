import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";

export interface SpanRec {
  id: string;
  parent?: string;
  name: string;
  attrs: Record<string, unknown>;
  start: number;
  ms?: number;
  done: boolean;
  error?: string;
  events?: { name: string; attrs: Record<string, unknown> }[];
}
export type SpanMap = Record<string, SpanRec>;

export const MAX_SPANS = 900;

interface SpanEvent {
  kind: "span";
  id: string;
  parent?: string;
  name: string;
  phase: "start" | "end";
  attrs?: Record<string, unknown>;
  t: number;
  ms?: number;
  error?: string;
  events?: SpanRec["events"];
}

/** Pure reducer for the AGI harness's OpenTelemetry span events. Returns the same map object when
 *  the event isn't a span (callers use that to decide whether to refresh other panels), and
 *  bounds memory by dropping the oldest spans beyond MAX_SPANS. */
export function applyAgiEvent(prev: SpanMap, raw: unknown): SpanMap {
  const e = raw as Partial<SpanEvent> | null;
  if (!e || e.kind !== "span" || typeof e.id !== "string" || typeof e.name !== "string") return prev;
  const cur = prev[e.id];
  const next: SpanRec =
    e.phase === "start"
      ? { id: e.id, parent: e.parent, name: e.name, attrs: e.attrs ?? {}, start: Number(e.t) || 0, done: false }
      : {
          ...(cur ?? { id: e.id, name: e.name, parent: e.parent, start: (Number(e.t) || 0) - (e.ms ?? 0) }),
          attrs: { ...(cur?.attrs ?? {}), ...(e.attrs ?? {}) },
          ms: e.ms,
          done: true,
          error: e.error,
          events: e.events,
        };
  const all: SpanMap = { ...prev, [e.id]: next };
  const ids = Object.keys(all);
  if (ids.length > MAX_SPANS) {
    for (const id of ids.sort((a, b) => all[a].start - all[b].start).slice(0, ids.length - MAX_SPANS)) delete all[id];
  }
  return all;
}

export const isSpanEvent = (e: unknown): boolean => (e as { kind?: string } | null)?.kind === "span";

/**
 * One streaming connection (admin only — the gateway enforces it too) feeding spans plus a `tick`
 * that other panels use to refresh on non-span events (goal / approval / evolution changes).
 * Reconnects with capped exponential backoff; never throws into React.
 */
export function useAgiEvents(enabled: boolean) {
  const [spans, setSpans] = useState<SpanMap>({});
  const [tick, setTick] = useState(0);
  const [connected, setConnected] = useState(false);
  const retry = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handle = (e: unknown) => {
      if (isSpanEvent(e)) setSpans((p) => applyAgiEvent(p, e));
      else setTick((t) => t + 1);
    };
    const connect = async () => {
      try {
        const recent = await api.agiRecent().catch(() => [] as unknown[]);
        for (const e of recent) handle(e);
        await api.agiStream(handle, ctl.signal, () => { retry.current = 0; setConnected(true); });
      } catch {
        /* fall through to reconnect */
      }
      setConnected(false);
      if (ctl.signal.aborted) return;
      retry.current = Math.min(retry.current + 1, 6);
      timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry.current));
    };
    void connect();
    return () => { ctl.abort(); if (timer) clearTimeout(timer); };
  }, [enabled]);

  return { spans, tick, connected };
}
