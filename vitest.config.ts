import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/; their copies of the tests must not run here.
    exclude: [...configDefaults.exclude, '.claude/**'],
    // GitHub's Windows runner runs the in-the-app tests (a real database and files in a temp folder)
    // 20 to 150 times slower than Linux, and stalls under load: a test that takes 40 ms here once took
    // 7 s there. Linux keeps the 5 s default, so a real slowdown still fails the build there.
    ...(process.platform === 'win32' ? { testTimeout: 30_000, hookTimeout: 30_000 } : {}),
  },
})
