import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/; their copies of the tests must not run here.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
})
