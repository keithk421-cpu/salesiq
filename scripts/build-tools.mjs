// Bundles the CLI/eval entry points (HELP eval runner, promptfoo provider) into dist-tools/.
import { build } from 'esbuild'
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning',
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  external: ['bufferutil', 'utf-8-validate'] }
await build({ ...common, entryPoints: ['scripts/help-eval.ts'], outfile: 'dist-tools/help-eval.mjs' })
await build({ ...common, entryPoints: ['evals/promptfoo/provider.ts'], outfile: 'dist-tools/promptfoo-provider.mjs' })
await build({ ...common, entryPoints: ['evals/promptfoo/tests.ts'], outfile: 'dist-tools/promptfoo-tests.mjs' })
await build({ ...common, entryPoints: ['evals/promptfoo/level1.ts'], outfile: 'dist-tools/promptfoo-level1.mjs' })
