import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  webServer: {
    command: 'node scripts/serve-site.mjs',
    port: 8811,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  use: { baseURL: 'http://localhost:8811' },
});
