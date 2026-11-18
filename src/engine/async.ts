import { hashKey, QueryClient, type QueryKey } from "@tanstack/query-core";
import { Memo } from "./schema-ops";
import type { AsyncEntry, Loaders } from "./types";

/** Every query this library makes is keyed ["schema-form", source, params]. */
export const QUERY_KEY = "schema-form";

/**
 * Minimal observable counter, shaped like a TanStack store ({ get, subscribe }).
 * `connect` is called while anyone is subscribed, so nothing leaks when no form is mounted.
 */
export class Notifier {
  private version = 0;
  private listeners = new Set<() => void>();
  private disconnect?: () => void;
  constructor(private connect?: (notify: () => void) => () => void) {}
  get = () => this.version;
  /** While someone listens, every change to our queries bumps the version. */
  get listening() {
    return this.listeners.size > 0;
  }
  subscribe = (fn: () => void) => {
    if (!this.listeners.size) this.disconnect = this.connect?.(() => this.notify());
    this.listeners.add(fn);
    return {
      unsubscribe: () => {
        this.listeners.delete(fn);
        if (!this.listeners.size) this.disconnect?.();
      },
    };
  };
  notify() {
    this.version++;
    for (const fn of [...this.listeners]) fn();
  }
}

/** A param that is empty means "not ready": nothing is fetched. */
export const isIncomplete = (params: Record<string, unknown>) => Object.values(params).some(isBlank);

/** No value: undefined, null or "". An empty param means "not ready"; an empty field skips its rules. */
export const isBlank = (v: unknown) => v === undefined || v === null || v === "";

const IDLE: AsyncEntry = Object.freeze({ status: "idle" });
const LOADING: AsyncEntry = Object.freeze({ status: "loading" });

/** A per-engine client; pass your own to share the cache between forms or with your app. */
export const createQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

/** Notify whenever one of our queries settles, is invalidated or is removed. */
export function watchQueries(client: QueryClient, notify: () => void) {
  return client.getQueryCache().subscribe((e) => {
    if (e.query.queryKey[0] === QUERY_KEY && (e.type === "updated" || e.type === "removed")) notify();
  });
}

/**
 * Loader results, cached in a TanStack QueryClient by (source, params).
 *
 * `read` is synchronous: it returns the current entry and starts the request if
 * there is none. Because entries are keyed by params, a select always shows the
 * list for the *current* parent value; responses for old params land in their
 * own cache slot and are never shown.
 *
 * Refresh with `queryClient.invalidateQueries({ queryKey: ["schema-form", source] })`:
 * the old data stays visible while the new request runs.
 */
export class AsyncCache {
  /** Entry objects stay identical while their query's result is unchanged. */
  private entries = new Memo<AsyncEntry>();

  constructor(
    private loaders: Loaders,
    private client: QueryClient,
  ) {}

  read(source: string, params: Record<string, unknown>): AsyncEntry {
    if (isIncomplete(params)) return IDLE;
    const queryKey = [QUERY_KEY, source, params];
    let state = this.client.getQueryState(queryKey);
    // Fetch when missing, reset, or invalidated after success. A failed query waits for retry()
    // (TanStack also flags errors as invalidated, which would otherwise refetch on every read).
    const idle = state?.fetchStatus === "idle";
    if (!state || (idle && (state.status === "pending" || (state.status === "success" && state.isInvalidated)))) {
      void this.client.prefetchQuery(this.query(source, params));
      state = this.client.getQueryState(queryKey)!;
    }
    if (state.status === "pending") return LOADING;
    const at = state.status === "success" ? state.dataUpdatedAt : state.errorUpdatedAt;
    return this.entries.get(`${hashKey(queryKey)}:${state.status}:${at}`, () =>
      state.status === "success"
        ? { status: "success", data: state.data }
        : { status: "error", error: state.error, retry: () => void this.client.prefetchQuery(this.query(source, params)) },
    );
  }

  /** Fetch fresh data now (e.g. on a button press), updating the shared cache entry. */
  fetch(source: string, params: Record<string, unknown>): Promise<unknown> {
    return this.client.fetchQuery(this.query(source, params));
  }

  private query(source: string, params: Record<string, unknown>) {
    return {
      queryKey: [QUERY_KEY, source, params] as QueryKey,
      queryFn: ({ signal }: { signal: AbortSignal }) => {
        const loader = this.loaders[source];
        if (!loader) throw new Error(`No loader registered for source "${source}"`);
        return loader(params, { signal });
      },
    };
  }
}
