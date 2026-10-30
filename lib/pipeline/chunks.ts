import "server-only";
import { env } from "@/lib/env";

/** Per-call overrides of the volume settings. Anything left out comes from the environment. */
export type StageOptions = {
  /** Max items for this call, across its chunks (default BATCH_LIMIT). */
  limit?: number;
  chunkSize?: number;
  delayMs?: number;
  /** Epoch ms after which no new work starts. Null/absent: no deadline. */
  deadlineAt?: number | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type ChunkSettings = {
  limit: number;
  chunkSize: number;
  delayMs: number;
  deadlineAt: number | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function resolveChunkSettings(opts: StageOptions = {}): ChunkSettings {
  const e = env();
  return {
    limit: Math.max(1, opts.limit ?? e.BATCH_LIMIT),
    chunkSize: Math.max(1, opts.chunkSize ?? e.STAGE_CHUNK_SIZE),
    delayMs: Math.max(0, opts.delayMs ?? e.STAGE_DELAY_MS),
    deadlineAt: opts.deadlineAt ?? null,
    sleep: opts.sleep ?? defaultSleep,
    now: opts.now ?? Date.now,
  };
}

export type ChunkContext = {
  /** True once the deadline has passed: stop starting new items. */
  timeUp: () => boolean;
  /** Milliseconds until the deadline (Infinity when there is none), so a slow item can decide not to start. */
  msLeft: () => number;
};

export type ChunkResult = {
  /** Items handed to `handle` (counts toward the limit). */
  attempted: number;
  chunks: number;
};

/**
 * Works through a queue `chunkSize` items at a time, pausing `delayMs` between chunks, until the
 * queue is empty, `limit` items have been handed out, the deadline passes, or `handle` says stop
 * (e.g. on a rate limit).
 *
 * `load(n)` must return up to n of the oldest queue items; handled items are expected to leave the
 * queue. An item already seen in this run is never handed out twice, so one that stays in the queue
 * (a failed save) cannot loop. A chunk shorter than requested means the queue is empty.
 */
export async function processInChunks<T extends { id: string }>(
  load: (n: number) => Promise<T[]>,
  s: ChunkSettings,
  handle: (items: T[], ctx: ChunkContext) => Promise<"continue" | "stop">,
): Promise<ChunkResult> {
  const ctx: ChunkContext = {
    timeUp: () => s.deadlineAt !== null && s.now() >= s.deadlineAt,
    msLeft: () => (s.deadlineAt === null ? Infinity : Math.max(0, s.deadlineAt - s.now())),
  };
  const seen = new Set<string>();
  let attempted = 0;
  let chunks = 0;

  while (attempted < s.limit) {
    if (ctx.timeUp()) break;
    const want = Math.min(s.chunkSize, s.limit - attempted);
    const loaded = await load(want);
    const fresh = loaded.filter((item) => !seen.has(item.id));
    if (fresh.length === 0) break;
    for (const item of fresh) seen.add(item.id);

    chunks++;
    attempted += fresh.length;
    if ((await handle(fresh, ctx)) === "stop") break;
    if (loaded.length < want) break; // queue exhausted
    if (attempted < s.limit && s.delayMs > 0) await s.sleep(s.delayMs);
  }
  return { attempted, chunks };
}
