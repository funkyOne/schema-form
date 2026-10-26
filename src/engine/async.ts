import type { AsyncEntry, Loaders } from "./types";

/** Minimal observable counter, shaped like a TanStack store ({ get, subscribe }). */
export class Notifier {
  private version = 0;
  private listeners = new Set<() => void>();
  get = () => this.version;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return { unsubscribe: () => this.listeners.delete(fn) };
  };
  notify() {
    this.version++;
    for (const fn of [...this.listeners]) fn();
  }
}

const IDLE: AsyncEntry = Object.freeze({ status: "idle" }) as AsyncEntry;

function stableKey(params: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]));
}

/**
 * Cache of loader results keyed by (source, params).
 *
 * `read` is synchronous: it returns the current entry and starts the request if
 * there is none. Because entries are keyed by params, a select always shows the
 * list for the *current* parent value; stale responses for old params simply land
 * in their own cache slot and are never shown.
 */
export class AsyncCache {
  private entries = new Map<string, AsyncEntry>();
  private controllers = new Map<string, AbortController>();

  constructor(
    private loaders: Loaders,
    private notifier: Notifier,
    private maxEntries = 500,
  ) {}

  read(source: string, params: Record<string, unknown>): AsyncEntry {
    if (Object.values(params).some((v) => v === undefined || v === null || v === "")) return IDLE;
    const key = `${source}:${stableKey(params)}`;
    const hit = this.entries.get(key);
    if (hit) return hit;

    const loader = this.loaders[source];
    if (!loader) {
      const entry: AsyncEntry = {
        status: "error",
        error: new Error(`No loader registered for source "${source}"`),
        retry: () => {},
      };
      this.entries.set(key, entry);
      return entry;
    }
    if (this.entries.size >= this.maxEntries) this.evict();

    const entry: AsyncEntry = { status: "loading" };
    this.entries.set(key, entry);
    const controller = new AbortController();
    this.controllers.set(key, controller);

    loader(params, { signal: controller.signal }).then(
      (data) => this.settle(key, entry, { status: "success", data }),
      (error) =>
        this.settle(key, entry, {
          status: "error",
          error,
          retry: () => {
            this.entries.delete(key);
            this.notifier.notify();
          },
        }),
    );
    return entry;
  }

  /** Drop every cached entry for a source (e.g. after the server data changed). */
  invalidate(source?: string) {
    for (const key of [...this.entries.keys()]) {
      if (!source || key.startsWith(source + ":")) {
        this.controllers.get(key)?.abort();
        this.controllers.delete(key);
        this.entries.delete(key);
      }
    }
    this.notifier.notify();
  }

  private settle(key: string, pending: AsyncEntry, next: AsyncEntry) {
    // Ignore if the entry was invalidated/replaced while in flight.
    if (this.entries.get(key) !== pending) return;
    this.controllers.delete(key);
    this.entries.set(key, next);
    this.notifier.notify();
  }

  private evict() {
    // Drop the oldest settled half; Map preserves insertion order.
    let n = Math.floor(this.entries.size / 2);
    for (const [key, entry] of this.entries) {
      if (n-- <= 0) break;
      if (entry.status !== "loading") this.entries.delete(key);
    }
  }
}
