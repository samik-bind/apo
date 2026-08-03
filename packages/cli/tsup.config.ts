import { defineConfig, type Options } from "tsup";

/**
 * Dist build for `@apo-ai/cli`.
 *
 * Bundles the CLI into a single ESM file with a Node shebang. Internal dev
 * does NOT go through this build — the monorepo runs the CLI via the
 * `pnpm apo` script which uses `--experimental-strip-types` on the raw
 * source. The published package ships only `dist/main.js`.
 *
 * Dynamic imports (`await import("./commands/${name}.ts")`) are preserved
 * via code splitting — tsup/esbuild creates per-command chunks that are
 * loaded lazily at runtime, keeping CLI startup fast.
 */

const external = [
  "@apo-ai/sdk",
  // Node builtins
  "child_process",
  "fs",
  "fs/promises",
  "os",
  "path",
  "url",
  "node:async_hooks",
  "node:child_process",
  "node:crypto",
  "node:fs",
  "node:os",
  "node:path",
  "node:process",
  "node:readline/promises",
  "node:tty",
  "node:url",
];

const config: Options = {
  entry: {
    main: "src/main.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node20",
  sourcemap: true,
  clean: true,
  splitting: true,
  dts: false,
  external,
  banner: {
    js: "#!/usr/bin/env node",
  },
};

export default defineConfig([config]);
