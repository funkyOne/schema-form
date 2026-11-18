import { batch, type Store } from "@tanstack/store";
import { createContext, useCallback, useContext, useMemo, useRef, type ComponentType, type ReactNode } from "react";
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/shim/with-selector";
import {
  isWithin,
  USER_SOURCE,
  withPatches,
  withSource,
  withoutIndex,
  withoutPath,
  type FormEngine,
  type FormErrors,
  type Patch,
  type Provenance,
  type ValidationResult,
} from "../engine";
import type { LayoutProps, RendererEntry } from "./controls";

/**
 * The TanStack form instance. Field names are built at runtime from the schema,
 * so the form is untyped by design; type your submit handler's data instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SchemaFormApi = any;

interface FormContextValue {
  form: SchemaFormApi;
  engine: FormEngine;
  renderers: RendererEntry[];
  /** Who last wrote each field (computes, prefills). Lives next to the values, saved in snapshots. */
  provenance: Store<Provenance>;
  /** Errors from checks the host runs itself (`externalErrors` prop), by check name. */
  external: Store<ExternalErrors>;
  /** Custom layout types by name (`layouts` prop). */
  layouts: Record<string, ComponentType<LayoutProps>>;
  /**
   * Validate the current values (schema, x-validate rules, loaded options) without submitting
   * or showing anything: e.g. to decide whether to run a remote check when the user reaches Review.
   * External errors are not included.
   */
  validateLocal: () => ValidationResult & { data: unknown };
}

/** Errors from host-run checks, by check name: `{ amc: { fields: { "a.b": "…" } } }`. */
export type ExternalErrors = Record<string, FormErrors | undefined>;

/** Write engine patches (computes, prefills, clearing) into the form and record their sources. */
export function applyPatches(ctx: Pick<FormContextValue, "form" | "provenance">, patches: readonly Patch[]) {
  if (!patches.length) return;
  // One batch, so stale-value clearing sees the final values, whatever order the patches come in.
  batch(() => {
    for (const p of patches) ctx.form.setFieldValue(p.path, p.value, { dontUpdateMeta: true });
    ctx.provenance.setState((prev) => withPatches(prev, patches));
  });
}

/** The user edited (or cleared) `path` themselves: computes leave it alone from now on. */
export function markManual(provenance: Store<Provenance>, path: string) {
  if (provenance.state[path] !== USER_SOURCE) provenance.setState((prev) => withSource(prev, path, USER_SOURCE));
}

/** A value disappeared (stale) or an array item was removed. */
export function forgetPath(provenance: Store<Provenance>, path: string) {
  provenance.setState((prev) => withoutPath(prev, path));
}
export function forgetIndex(provenance: Store<Provenance>, arrayPath: string, index: number) {
  provenance.setState((prev) => withoutIndex(prev, arrayPath, index));
}

export const FormContext = createContext<FormContextValue | null>(null);

/** Access the form, engine and renderers from inside a custom renderer. */
export function useSchemaForm(): FormContextValue {
  const ctx = useContext(FormContext);
  if (!ctx) throw new Error("useSchemaForm must be used inside <SchemaForm>");
  return ctx;
}

// ---------------------------------------------------------------- base path + inherited disabled

interface BaseValue {
  /** Base for relative UI-schema paths: "" at the root, "claims[2]" inside an array item. */
  base: string;
  /** Set when an ancestor field is disabled by `x-disabled`. */
  disabled: boolean;
}

const BaseContext = createContext<BaseValue>({ base: "", disabled: false });

export function useBase() {
  return useContext(BaseContext);
}

export function BaseProvider({ base, disabled, children }: { base?: string; disabled?: boolean; children: ReactNode }) {
  const parent = useContext(BaseContext);
  const b = base ?? parent.base;
  const d = parent.disabled || !!disabled;
  const value = useMemo(() => ({ base: b, disabled: d }), [b, d]);
  return <BaseContext.Provider value={value}>{children}</BaseContext.Provider>;
}

// ---------------------------------------------------------------- subscriptions

type FormState = { values: unknown; [key: string]: any };
interface Snapshot {
  state: FormState;
  version: number;
  external: ExternalErrors;
}

/**
 * Subscribe to a derived value of the form state. Re-renders only when the
 * selected value changes. Also re-runs when async data arrives or a oneOf
 * branch is picked (engine.notifier), since those change what is resolved.
 */
export function useFormSelector<T>(
  select: (state: FormState, external: ExternalErrors) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  const { form, engine, external } = useSchemaForm();
  const snap = useRef<Snapshot | null>(null);

  const subscribe = useCallback(
    (onChange: () => void) => {
      const a = form.store.subscribe(onChange);
      const b = engine.notifier.subscribe(onChange);
      const c = external.subscribe(onChange);
      return () => {
        a.unsubscribe();
        b.unsubscribe();
        c.unsubscribe();
      };
    },
    [form, engine, external],
  );

  const getSnapshot = useCallback(() => {
    const state = form.store.state as FormState;
    const version = engine.notifier.get();
    const ext = external.state;
    const cur = snap.current;
    if (cur && cur.state === state && cur.version === version && cur.external === ext) return cur;
    return (snap.current = { state, version, external: ext });
  }, [form, engine, external]);

  return useSyncExternalStoreWithSelector(subscribe, getSnapshot, getSnapshot, (s) => select(s.state, s.external), isEqual);
}

// ---------------------------------------------------------------- one error stream

const NO_ERRORS: string[] = [];

const flatMemo = new WeakMap<ExternalErrors, Required<FormErrors>>();

/** All checks' errors as one `{ fields, form }`; the first check to name a path wins. */
export function flattenExternal(external: ExternalErrors): FormErrors & { fields: Record<string, string> } {
  let flat = flatMemo.get(external);
  if (!flat) {
    flat = { fields: {}, form: "" };
    for (const e of Object.values(external)) {
      for (const [p, m] of Object.entries(e?.fields ?? {})) if (m) flat.fields[p] ??= m;
      if (e?.form && !flat.form) flat.form = e.form;
    }
    flatMemo.set(external, flat);
  }
  return { fields: flat.fields, form: flat.form || undefined };
}

/**
 * Messages showing on `path` right now, most important first:
 * external checks › server / schema errors (after a submit attempt) › live `x-validate` rules
 * (once the field was edited, or after a submit attempt).
 */
function errorsAt(engine: FormEngine, state: FormState, external: ExternalErrors, path: string): string[] {
  const meta = state.fieldMeta?.[path];
  const out: string[] = [];
  const add = (m: unknown) => typeof m === "string" && m && !out.includes(m) && out.push(m);
  add(flattenExternal(external).fields[path]);
  for (const m of meta?.errors ?? []) add(m);
  if (meta?.isDirty || state.submissionAttempts > 0) add(engine.ruleErrors(state.values)[path]);
  return out.length ? out : NO_ERRORS;
}

/** Messages showing on one field (or on an object / array as a whole). */
export function useFieldErrors(path: string): string[] {
  const { engine } = useSchemaForm();
  return useFormSelector((s, ext) => errorsAt(engine, s, ext, path), shallowArrayEqual);
}

/**
 * Every error by field path, merged into one stream: external checks, server errors, schema
 * errors and `x-validate` rules.
 * - default: what the fields show right now (schema errors only after a submit attempt).
 * - `all: true`: everything that would block a submit, shown or not; e.g. for a stepper's
 *   error badges once the user has reached Review.
 * A form-level message (root error, still loading, failed load) is under the "" key.
 */
export function useFormErrors({ all = false }: { all?: boolean } = {}): Record<string, string> {
  const { engine } = useSchemaForm();
  return useFormSelector((s, ext) => {
    const flat = flattenExternal(ext);
    const out: Record<string, string> = { ...flat.fields };
    let formError: unknown;
    if (all) {
      const r = engine.validate(s.values);
      for (const [p, m] of Object.entries(r.fields)) out[p] ??= m;
      formError = r.form;
    } else {
      for (const p of new Set([...Object.keys(s.fieldMeta ?? {}), ...Object.keys(engine.ruleErrors(s.values))])) {
        const first = errorsAt(engine, s, ext, p)[0];
        if (first) out[p] ??= first;
      }
      formError = s.errorMap?.onDynamic ?? s.errorMap?.onServer;
    }
    const form = flat.form ?? (typeof formError === "string" ? formError : undefined);
    if (form) out[""] = form;
    return out;
  }, shallowRecordEqual);
}

/** The errors among `errors` that belong to any of `paths` or to fields under them. */
export function errorsWithin(errors: Record<string, string>, paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).filter(([p]) => p && paths.some((a) => isWithin(p, a))));
}

export const shallowRecordEqual = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

export const shallowArrayEqual = (a?: readonly unknown[], b?: readonly unknown[]) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));
