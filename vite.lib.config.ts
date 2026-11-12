import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const external = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies), "react/jsx-runtime"];

/** Library build: one ESM bundle per entry, every dependency left external. Declarations come from tsc. */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: { "engine/index": "src/engine/index.ts", "react/index": "src/react/index.ts" },
      formats: ["es"],
    },
    rollupOptions: { external: (id) => external.some((e) => id === e || id.startsWith(e + "/")) },
  },
});
