import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright-core";
import { createServer } from "vite";
import { resolveChromiumExecutable } from "../../../../tests/browser-helpers.mjs";

test("clipped dashboard tab labels remain readable with pointer and keyboard", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    server: { port: 0, hmr: false },
    appType: "spa",
  });
  let browser;
  try {
    await server.listen();
    for (const browserType of [chromium, webkit]) {
      browser = await browserType.launch({
        ...(browserType === chromium ? { executablePath: resolveChromiumExecutable() } : {}), headless: true,
      });
      for (const width of [390, 1200]) {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(`http://localhost:${server.httpServer.address().port}/tests/fixtures/dashboard-tabs.html`);

        const longName = "Core Agentic Product Adoption and Customer Growth";
        const longTab = page.getByRole("tab", { name: longName, exact: true });
        const tooltip = page.locator(".truncated-text-tooltip");
        assert.equal(await longTab.getAttribute("aria-label"), longName);
        assert.equal(await longTab.locator(".dashboard-tab-label").getAttribute("data-overflowing"), "true");
        await longTab.locator(".dashboard-tab-label").hover();
        await tooltip.waitFor({ state: "visible" });
        assert.equal(await tooltip.innerText(), longName);
        assert.equal(await tooltip.getAttribute("aria-hidden"), "true");
        await page.mouse.move(0, 200);
        await tooltip.waitFor({ state: "hidden" });

        await longTab.focus();
        await tooltip.waitFor({ state: "visible" });
        assert.equal(await longTab.getAttribute("aria-describedby"), null);
        await page.keyboard.press("Escape");
        await tooltip.waitFor({ state: "hidden" });
        await page.keyboard.press("ArrowRight");
        const second = page.getByRole("tab", { name: "Company Wide Growth and Retention by Product" });
        assert.equal(await second.getAttribute("aria-selected"), "true");
        assert.equal(await second.evaluate(element => document.activeElement === element), true);
        await tooltip.waitFor({ state: "visible" });
        assert.equal(await tooltip.innerText(), "Company Wide Growth and Retention by Product");
        await page.keyboard.press("ArrowRight");
        const shortTab = page.getByRole("tab", { name: "Short" });
        assert.equal(await shortTab.getAttribute("aria-selected"), "true");
        assert.equal(await shortTab.evaluate(element => document.activeElement === element), true);
        await tooltip.waitFor({ state: "hidden" });

        await shortTab.hover();
        assert.equal(await tooltip.count(), 0);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert.deepEqual(errors, []);
        await page.close();
      }
      await browser.close();
      browser = null;
    }
  } finally {
    await browser?.close();
    await server.close();
  }
});
