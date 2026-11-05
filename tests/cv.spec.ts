/**
 * Behavioural tests for the CV page: content decisions, typography, colour
 * schemes, accessibility, responsive layout, print output and the legacy /cv
 * redirect.
 *
 * @author John Grimes
 */

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// A4 in PostScript points, as reported by PDF page boxes.
const A4 = { width: 595.28, height: 841.89 };

// 10pt in CSS pixels (1pt = 4/3px).
const TEN_POINT_PX = 40 / 3;

/**
 * Prints the page to PDF as the browser would and returns each page's size
 * and text.
 *
 * @param page - The Playwright page, already loaded.
 * @returns One entry per PDF page, with width and height in points.
 */
const printPages = async (page: Page) => {
  await page.evaluate(() => document.fonts.ready);
  // preferCSSPageSize makes the stylesheet's @page rule decide the size,
  // as it does when printing from the browser.
  const data = await page.pdf({
    preferCSSPageSize: true,
    printBackground: true,
  });
  const pdf = await getDocument({ data: new Uint8Array(data) }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const p = await pdf.getPage(n);
    const { width, height } = p.getViewport({ scale: 1 });
    const { items } = await p.getTextContent();
    // Text arrives in paint order, so sort it top to bottom, then left to
    // right, to get the order a reader sees. PDF y runs upwards.
    const text = items
      .flatMap((item) =>
        "str" in item && item.str.trim()
          ? [{ str: item.str, x: item.transform[4], y: item.transform[5] }]
          : [],
      )
      .sort((a, b) => Math.round(b.y) - Math.round(a.y) || a.x - b.x)
      .map((item) => item.str);
    pages.push({ width, height, text: text.join(" ") });
  }
  return pages;
};

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

  test("describes the SQL on FHIR role as project lead", async ({ page }) => {
    const entry = page.locator("#selected-work article", {
      has: page.locator("h3", { hasText: "SQL on FHIR" }),
    });
    await expect(entry.locator(".role")).toContainText(/Project lead, HL7/);
    // The page as a whole no longer describes the role as shared.
    await expect(page.locator("body")).not.toContainText(/co-lead/i);
    const description = await page
      .locator("meta[name='description'], meta[property='og:description']")
      .evaluateAll((metas) => metas.map((m) => m.getAttribute("content")));
    for (const content of description) expect(content).not.toMatch(/co-lead/i);
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

test("shows the first selected-work outcome without scrolling on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  // The evidence, not just the profile, has to reach the first screen.
  await expect(page.locator("#selected-work .entry li").first()).toBeInViewport(
    { ratio: 0.5 },
  );
});

test("gives contact links touch targets at least 44px tall on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  for (const link of await page.locator("header .contact a").all()) {
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
});

test("labels profile links by service on screen and by address in print", async ({
  page,
}) => {
  const addresses = [
    "github.com/johngrimes",
    "linkedin.com/in/johngrimes",
    "orcid.org/0000-0002-9575-7641",
  ];
  await page.goto("/");
  // On screen the links are tappable, so short names are enough.
  for (const name of ["GitHub", "LinkedIn", "ORCID"]) {
    await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  }
  const contact = page.locator("header .contact");
  for (const address of addresses) {
    await expect(contact).not.toContainText(address, { useInnerText: true });
  }
  // On paper the reader has to type the address, so print it in full.
  await page.emulateMedia({ media: "print" });
  for (const address of addresses) {
    await expect(contact).toContainText(address, { useInnerText: true });
  }
});

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

test.describe("print", () => {
  test("prints to no more than two A4 pages", async ({ page }) => {
    await page.goto("/");
    const pages = await printPages(page);
    expect(pages.length).toBeLessThanOrEqual(2);
    for (const p of pages) {
      expect(p.width).toBeCloseTo(A4.width, 0);
      expect(p.height).toBeCloseTo(A4.height, 0);
    }
  });

  test("starts every continuation page at a heading, not mid-entry", async ({
    page,
  }) => {
    await page.goto("/");
    // A page may open with a heading, or with a note that introduces the
    // entries below it. Compare without case or whitespace: small caps and
    // line breaks differ between the DOM and the PDF text layer.
    const starts = (
      await page.locator("main h2, main h3, main .note").allTextContents()
    ).map((h) => h.replace(/\s+/g, "").toLowerCase());
    const pages = await printPages(page);
    for (const p of pages.slice(1)) {
      const text = p.text.replace(/\s+/g, "").toLowerCase();
      // A page that opens with a stray bullet has lost its role and employer.
      expect(
        starts.some((s) => text.startsWith(s)),
        `page starts: ${p.text.slice(0, 60)}`,
      ).toBe(true);
    }
  });

  test("sets printed body text at no less than 10pt", async ({ page }) => {
    await page.emulateMedia({ media: "print" });
    await page.goto("/");
    for (const selector of ["#profile p", "#experience .entry li"]) {
      const size = await page
        .locator(selector)
        .first()
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(size, selector).toBeGreaterThanOrEqual(TEN_POINT_PX - 0.01);
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
