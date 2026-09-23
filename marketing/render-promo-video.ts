import { chromium } from "@playwright/test";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const marketingDir = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(marketingDir, "promo-video.html");
const renderDir = path.join(marketingDir, ".promo-video-render");
const durationMs = 42_000;

await mkdir(renderDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: {
    dir: renderDir,
    size: { width: 1280, height: 720 },
  },
});
const page = await context.newPage();

try {
  await page.goto(pathToFileURL(htmlPath).href);
  await page.waitForFunction(() =>
    Boolean((window as Window & { __promoReady?: boolean }).__promoReady),
  );
  await page.waitForTimeout(durationMs + 450);
} finally {
  await context.close();
  await browser.close();
}

const renderedFiles = await readdir(renderDir);
const videos = await Promise.all(
  renderedFiles
    .filter((file) => file.endsWith(".webm"))
    .map(async (file) => ({
      file,
      modifiedAt: (await stat(path.join(renderDir, file))).mtimeMs,
    })),
);
const newest = videos.sort((left, right) => right.modifiedAt - left.modifiedAt)[0];

if (!newest) {
  throw new Error(`Playwright did not produce a video in ${renderDir}`);
}

console.log(path.join(renderDir, newest.file));
