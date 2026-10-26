export { FormEngine, prune, findUnsupported, type EngineOptions, type RuleState } from "./engine";
export * from "./types";
export * from "./path";

import type { FormEngine } from "./engine";
import { parsePath } from "./path";

/**
 * Expose the engine as a Standard Schema validator, so the same schema + UI rules
 * can validate on the server (or be handed to any Standard Schema consumer).
 * Note: async-backed fields (x-options / x-extend) must be loaded first.
 */
export function toStandardSchema(engine: FormEngine) {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "schema-form",
      validate(value: unknown) {
        const r = engine.validate(value);
        if (r.valid) return { value: r.data };
        const issues = Object.entries(r.fields).map(([path, message]) => ({
          message,
          path: parsePath(path),
        }));
        if (r.form) issues.push({ message: r.form, path: [] });
        return { issues };
      },
    },
  };
}
