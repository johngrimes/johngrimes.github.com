/**
 * Behavioural tests for the CV page: content decisions, typography, colour
 * schemes, accessibility, responsive layout, print output and the legacy /cv
 * redirect.
 *
 * @author John Grimes
 */

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

// A4 in PostScript points, as reported by PDF page boxes.
const A4 = { width: 595.28, height: 841.89 };

// ---------------------------------------------------------------------------
// Content and structure
// ---------------------------------------------------------------------------

test.describe("content", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("identifies John and his field in the header and document metadata", async ({
    page,
  }) => {
    await expect(page).toHaveTitle(/John Grimes/);
    await expect(page.locator("header h1")).toHaveText("John Grimes");
    // The headline agreed during requirements, verbatim.
    await expect(page.locator("header .headline")).toHaveText(
      "Health Data Interop + Analytics",
    );
    // Australian English drives hyphenation and spell-checking.
    await expect(page.locator("html")).toHaveAttribute("lang", "en-AU");
  });

  test("orders sections work-first", async ({ page }) => {
    expect(await page.locator("main > section > h2").allTextContents()).toEqual(
      [
        "Profile",
        "Selected work",
        "Experience",
        "Standards and speaking",
        "Publications",
        "Skills",
        "Education",
      ],
    );
  });

  test("gives full selected-work entries to Pathling and SQL on FHIR only", async ({
    page,
  }) => {
    const titles = page.locator("#selected-work article h3");
    await expect(titles).toHaveText(["Pathling", "SQL on FHIR"]);
  });

  test("describes the SQL on FHIR role as project co-lead", async ({
    page,
  }) => {
    const entry = page.locator("#selected-work article", {
      has: page.locator("h3", { hasText: "SQL on FHIR" }),
    });
    await expect(entry).toContainText(/co-lead/i);
  });

  test("links to email, GitHub, LinkedIn and ORCID and nothing else", async ({
    page,
  }) => {
    const hrefs = await page
      .locator("header .contact a")
      .evaluateAll((links) => links.map((a) => a.getAttribute("href")));
    expect(hrefs.sort()).toEqual(
      [
        "mailto:john@grimes.id.au",
        "https://github.com/johngrimes",
        "https://www.linkedin.com/in/johngrimes",
        "https://orcid.org/0000-0002-9575-7641",
      ].sort(),
    );
  });

  test("publishes no phone number anywhere in the source", async ({
    page,
    request,
  }) => {
    // Check the raw HTML, not just the rendered text: the old CV hid its
    // phone number from the screen but still published it in the source.
    const html = await (await request.get("/")).text();
    expect(html).not.toMatch(/(\+61|\b0)4\d{2}[\s-]?\d{3}[\s-]?\d{3}/);
    expect(html).not.toMatch(/tel:/i);
    await expect(page.locator("body")).not.toContainText(/phone|mobile/i);
  });

  test("does not include recommendations", async ({ page }) => {
    await expect(page.locator("#recommendations")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/recommendation/i);
  });

  test("lists exactly the first-author papers and software", async ({
    page,
  }) => {
    const dois = await page
      .locator("#publications a[href^='https://doi.org/']")
      .evaluateAll((links) =>
        links.map((a) =>
          a.getAttribute("href")!.replace("https://doi.org/", ""),
        ),
      );
    expect([...new Set(dois)].sort()).toEqual(
      [
        // Papers
        "10.1038/s41746-025-01708-w",
        "10.1186/s13326-022-00277-1",
        // Software
        "10.25919/ezpq-qv35",
        "10.25919/vnzg-tn91",
        "10.25919/n7r2-rw40",
        "10.25919/tpa2-p969",
        "10.25919/03y2-d383",
      ].sort(),
    );
  });

  test("condenses pre-2010 roles into one-line entries", async ({ page }) => {
    const earlier = page.locator("#earlier li");
    await expect(earlier).toHaveCount(4);
    await expect(earlier.filter({ hasText: "Suncorp" })).toHaveCount(1);
    // One-line entries carry no paragraphs of description.
    await expect(page.locator("#earlier p")).toHaveCount(0);
  });

  test("lists independent product work", async ({ page }) => {
    await expect(page.locator("#independent-work")).toContainText("TypeFront");
  });

  test("uses no em dashes", async ({ page }) => {
    await expect(page.locator("body")).not.toContainText("\u2014");
  });
});

// ---------------------------------------------------------------------------
// Typography and colour
// ---------------------------------------------------------------------------

test.describe("typography", () => {
  test("sets body text in self-hosted Source Serif 4 with old-style figures", async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    const body = await page
      .locator("#profile p")
      .first()
      .evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          family: style.fontFamily,
          numeric: style.fontVariantNumeric,
        };
      });
    expect(body.family).toMatch(/^"Source Serif 4"/);
    expect(body.numeric).toContain("oldstyle-nums");
    // The faces must actually load, not silently fall back.
    expect(
      await page.evaluate(() => document.fonts.check('1em "Source Serif 4"')),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.fonts.check('1em "Source Sans 3"')),
    ).toBe(true);
  });

  test("sets labels such as dates in Source Sans 3 with tabular figures", async ({
    page,
  }) => {
    await page.goto("/");
    const date = await page
      .locator("#experience time")
      .first()
      .evaluate((el) => {
        const style = getComputedStyle(el);
        return { family: style.fontFamily, numeric: style.fontVariantNumeric };
      });
    expect(date.family).toMatch(/^"Source Sans 3"/);
    expect(date.numeric).toContain("tabular-nums");
  });

  test("makes no requests outside the site's own origin", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    const foreign = requests.filter(
      (url) => !url.startsWith("http://localhost:4173/"),
    );
    expect(foreign).toEqual([]);
  });

  test("switches paper and ink colours for a dark colour scheme", async ({
    page,
  }) => {
    const colours = async () =>
      page.locator("body").evaluate((el) => {
        const style = getComputedStyle(el);
        return [style.backgroundColor, style.color];
      });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const light = await colours();
    await page.emulateMedia({ colorScheme: "dark" });
    const dark = await colours();
    expect(dark[0]).not.toEqual(light[0]);
    expect(dark[1]).not.toEqual(light[1]);
  });
});

// ---------------------------------------------------------------------------
// Accessibility and layout
// ---------------------------------------------------------------------------

for (const colorScheme of ["light", "dark"] as const) {
  test(`has no detectable accessibility violations in ${colorScheme} mode`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}

test("does not scroll horizontally on a 320px-wide screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

test.describe("print", () => {
  test("prints to no more than two A4 pages", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    // preferCSSPageSize makes the stylesheet's @page rule decide the size,
    // as it does when printing from the browser.
    const pdf = await PDFDocument.load(
      await page.pdf({ preferCSSPageSize: true, printBackground: true }),
    );
    const pages = pdf.getPages();
    expect(pages.length).toBeLessThanOrEqual(2);
    for (const p of pages) {
      expect(p.getWidth()).toBeCloseTo(A4.width, 0);
      expect(p.getHeight()).toBeCloseTo(A4.height, 0);
    }
  });

  test("prints dark ink on white paper even in dark mode", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark", media: "print" });
    await page.goto("/");
    const background = await page
      .locator("body")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background).toBe("rgb(255, 255, 255)");
  });
});

// ---------------------------------------------------------------------------
// Legacy URL
// ---------------------------------------------------------------------------

test("redirects the old /cv address to the home page", async ({ page }) => {
  await page.goto("/cv");
  await page.waitForURL("http://localhost:4173/");
  await expect(page.locator("header h1")).toHaveText("John Grimes");
});
