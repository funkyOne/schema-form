import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/shim/with-selector";
import type { FormEngine } from "../engine";
import type { RendererEntry } from "./controls";

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
}

const FormContext = createContext<FormContextValue | null>(null);

export function FormProvider({ value, children }: { value: FormContextValue; children: ReactNode }) {
  return <FormContext.Provider value={value}>{children}</FormContext.Provider>;
}

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
  /** Set by a DISABLE rule on an ancestor layout/control. */
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

/**
 * Subscribe to a derived value of the form state. Re-renders only when the
 * selected value changes. Also re-runs when async data arrives or a oneOf
 * branch is picked (engine.notifier), since those change what is resolved.
 */
export function useFormSelector<T>(select: (state: FormState) => T, isEqual?: (a: T, b: T) => boolean): T {
  const { form, engine } = useSchemaForm();
  const snap = useRef<{ state: FormState; version: number } | null>(null);

  const subscribe = useCallback(
    (onChange: () => void) => {
      const a = form.store.subscribe(onChange);
      const b = engine.notifier.subscribe(onChange);
      return () => {
        a.unsubscribe();
        b.unsubscribe();
      };
    },
    [form, engine],
  );

  const getSnapshot = useCallback(() => {
    const state = form.store.state as FormState;
    const version = engine.notifier.get();
    const cur = snap.current;
    if (cur && cur.state === state && cur.version === version) return cur;
    return (snap.current = { state, version });
  }, [form, engine]);

  return useSyncExternalStoreWithSelector(subscribe, getSnapshot, getSnapshot, (s) => select(s.state), isEqual);
}

export const shallowArrayEqual = (a?: readonly unknown[], b?: readonly unknown[]) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));
