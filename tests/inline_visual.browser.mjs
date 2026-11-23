// Run with playwright-core on NODE_PATH and CHROME_PATH pointing to a Chromium executable.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { inline_visual_document } from "../frontend/inline-visual.js";

test("an isolated visual fits its slider below a heading and reports pointer entry", async () => {
  const { chromium } = createRequire(import.meta.url)("playwright-core");
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  try {
    const page = await browser.newPage();
    await page.route("http://visual.test/", route => route.fulfill({
      contentType: "text/html", body: '<iframe sandbox="allow-scripts"></iframe>',
    }));
    await page.goto("http://visual.test/");
    const source = "<h2>Allocation</h2><label>Design <input type=range></label>";
    await page.evaluate(doc => {
      const frame = document.querySelector("iframe");
      window.events = [];
      window.addEventListener("message", event => {
        if (event.source !== frame.contentWindow) return;
        if (event.data.codiscuss_visual_height) frame.style.height = event.data.codiscuss_visual_height + "px";
        if (typeof event.data.codiscuss_visual_hover === "boolean") window.events.push(event.data.codiscuss_visual_hover);
      });
      frame.srcdoc = doc;
    }, inline_visual_document(source, true));
    await page.waitForFunction(() => document.querySelector("iframe").style.height);
    const slider = page.frameLocator("iframe").locator("input");
    assert.ok(await slider.evaluate(element => element.getBoundingClientRect().bottom <= innerHeight));
    await slider.hover();
    await page.waitForFunction(() => window.events.at(-1) === true);
  } finally {
    await browser.close();
  }
});
