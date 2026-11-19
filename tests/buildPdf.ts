/**
 * Builds the PDF form of the CV from index.html. Run it with `bun run pdf`
 * after changing the page or its stylesheet.
 *
 * @author John Grimes
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";

import config from "../playwright.config";
import { PDF_PATH, readPdf, renderPdf } from "./pdf";

// The browser is set up as it is for the tests, which check the result.
const browser = await chromium.launch(config.use?.launchOptions);
try {
  const page = await browser.newPage();
  // The page needs no server: it loads its stylesheet and fonts from disk.
  await page.goto(
    pathToFileURL(join(import.meta.dir, "..", "index.html")).href,
  );
  const data = await renderPdf(page);
  await Bun.write(PDF_PATH, data);
  const { pages } = await readPdf(data);
  console.log(`Wrote ${PDF_PATH} (${pages.length} pages)`);
} finally {
  await browser.close();
}
