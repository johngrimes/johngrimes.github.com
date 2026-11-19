/**
 * Tests for john-grimes-cv.pdf, the published PDF form of the CV: that it
 * matches the page it is built from, and that it is a well-made PDF. The
 * layout of the printed pages is tested with the page, in cv.spec.ts.
 *
 * @author John Grimes
 */

import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { flatten, PDF_PATH, readPdf, renderPdf, type PdfContent } from "./pdf";

let published: PdfContent;

test.beforeAll(async () => {
  published = await readPdf(await readFile(PDF_PATH));
});

test("is up to date with the page and its stylesheet", async ({ page }) => {
  await page.goto("/");
  const fresh = await readPdf(await renderPdf(page));
  const stale = "john-grimes-cv.pdf is out of date: run `bun run pdf`";
  // The files themselves always differ, because each records when it was
  // made. Instead, each page must hold the same lines of text.
  const lines = (pdf: PdfContent) =>
    pdf.pages.map((p) => p.items.map((item) => item.str));
  expect(lines(published), stale).toEqual(lines(fresh));
  // Each line must also be where a fresh copy puts it. A point of leeway
  // covers the small differences in the width of text between macOS and
  // Linux, and is far less than a change to the layout moves the text.
  published.pages.forEach((p, n) => {
    p.items.forEach((item, i) => {
      const now = fresh.pages[n].items[i];
      const moved = Math.max(
        Math.abs(item.x - now.x),
        Math.abs(item.y - now.y),
      );
      expect(moved, `${stale} (${item.str})`).toBeLessThan(1);
    });
  });
});

test("holds the text of the page in reading order", async ({ page }) => {
  // A program that reads the PDF, such as a search index or a recruiter's
  // CV parser, receives the text in the order the file holds it, wherever
  // it sits on the page.
  await page.emulateMedia({ media: "print" });
  await page.goto("/");
  const expected = flatten(await page.locator("body").innerText());
  const count = published.pages.length;
  const text = published.pages.map((p, n) =>
    flatten(p.items.map((i) => i.str).join(""))
      // The foot of each page is not part of the page's text.
      .replace(flatten(`John Grimes · ${n + 1} / ${count}`), ""),
  );
  expect(text.join("")).toBe(expected);
});

test("names its title, author, subject and language", async ({ page }) => {
  await page.goto("/");
  const description = await page
    .locator("meta[name='description']")
    .getAttribute("content");
  expect(published.info).toMatchObject({
    Title: await page.title(),
    Author: "John Grimes",
    Subject: description,
    Language: "en-AU",
  });
});

test("is tagged with its structure for assistive technology", () => {
  expect(published.tagged).toBe(true);
});

test("embeds every font as outlines, all of them IBM Plex", () => {
  expect(published.fonts.length).toBeGreaterThan(0);
  for (const font of published.fonts) {
    expect(font.name).toMatch(/IBMPlex(Serif|Sans)/);
    expect(font.embedded, font.name).toBe(true);
    // A variable font is embedded as Type 3, which carries the shapes of the
    // glyphs but not the hinting, and which some viewers draw poorly.
    expect(font.type3, font.name).toBe(false);
  }
});

test("makes every link on the page live", async ({ page }) => {
  await page.goto("/");
  const hrefs = await page
    .locator("body a[href]")
    .evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).href));
  // A link that wraps onto a second line is listed once for each line.
  const links = new Set(published.pages.flatMap((p) => p.links));
  expect([...links].sort()).toEqual([...new Set(hrefs)].sort());
});
