import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4196", isMobile: true, hasTouch: true },
  projects: [
    { name: "mobile-chromium", use: { browserName: "chromium", viewport: { width: 390, height: 844 } } },
    { name: "mobile-webkit", use: { browserName: "webkit", viewport: { width: 320, height: 844 } } },
  ],
  webServer: {
    command: "vite preview --host 127.0.0.1 --port 4196 --strictPort",
    url: "http://127.0.0.1:4196",
    reuseExistingServer: false,
  },
});
