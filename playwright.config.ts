import { defineConfig, devices } from '@playwright/test'

const origin = `http://127.0.0.1:${process.env.PORT || '3020'}`

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: origin, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
  ],
  webServer: { command: 'npm start', url: origin, reuseExistingServer: !process.env.CI, timeout: 60_000 },
})
