/**
 * Behavioural tests for the CV page: content decisions, typography, colour
 * schemes, accessibility, responsive layout, print output and the legacy /cv
 * redirect.
 *
 * @author John Grimes
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

  test("draws the headline plus as an accent-coloured square mark", async ({
    page,
  }) => {
    const headline = page.locator("header .headline");
    // The mark replaces the typed plus but still reads as "+" to assistive
    // technology.
    const mark = headline.getByRole("img", { name: "+" });
    await expect(mark).toBeVisible();
    // The square takes the headline's accent colour in either scheme.
    const [markColour, headlineColour] = await Promise.all([
      mark.evaluate((el) => getComputedStyle(el).color),
      headline.evaluate((el) => getComputedStyle(el).color),
    ]);
    expect(markColour).toBe(headlineColour);
  });

  test("orders sections work-first", async ({ page }) => {
    expect(await page.locator("main > section > h2").allTextContents()).toEqual(
      [
        "Profile",
        "Selected work",
        "Experience",
        "Speaking and engagement",
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

  test("lists exactly the first-author papers, specifications and software", async ({
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
        // Specifications
        "10.5281/zenodo.14166591",
        // Software
        "10.25919/ezpq-qv35",
        "10.25919/vnzg-tn91",
        "10.25919/n7r2-rw40",
        "10.25919/tpa2-p969",
        "10.25919/03y2-d383",
      ].sort(),
    );
  });

  test("lists the health data standards and specifications", async ({
    page,
  }) => {
    // Standards come first, ahead of the papers and the open source software.
    const heading = page.locator("#standards-specs-heading");
    await expect(heading).toHaveText(
      "Health data standards and specifications",
    );
    await expect(page.locator("#standards-specs-heading + ul cite")).toHaveText(
      ["SQL on FHIR", "Parquet on FHIR"],
    );
    await expect(page.locator("#publications h3")).toHaveText([
      "Health data standards and specifications",
      "Peer-reviewed publications",
      "Open source software",
    ]);
  });

  test("links to recorded conference talks", async ({ page }) => {
    // Talks are listed newest first, each linking to its YouTube recording.
    const talks = page.locator("#talks li");
    await expect(page.locator("#talks-heading")).toHaveText("Recorded talks");
    await expect(talks.locator("a")).toHaveText([
      "Validation of SQL on FHIR via clinical study replication",
      "Pathling: SQL on FHIR views for Apache Spark",
      "Architecting explainable AI decision support on FHIR",
      "Using FHIR terminology within data analytics",
      "A new tool for representing SNOMED CT concepts for use in model training",
      "Developing new user interfaces for Expression Constraint Language queries",
      "Pathling: bringing the power of SNOMED CT to analytics app development",
      "Terminology analytics",
      "Australia’s FHIR based National Clinical Terminology Service",
    ]);
    const hrefs = await talks
      .locator("a")
      .evaluateAll((links) => links.map((a) => a.getAttribute("href")));
    expect(hrefs).toEqual(
      [
        "UppNaETsNiE",
        "e-hFKckQITw",
        "W2ZiooBTd9Q",
        "naA7XVfeMdY",
        "w5vr3BHQ26Y",
        "qW3jVsYjMq8",
        "S5nlVWgI3u4",
        "wmnsUEX-K9Q",
        "wFAYye7hM-c",
      ].map((id) => `https://www.youtube.com/watch?v=${id}`),
    );
    // Each talk names the event and where it was held.
    await expect(talks.locator("span:not(.dates)")).toHaveText([
      /, Analytics on FHIR, online$/,
      /, Analytics on FHIR, online$/,
      /, FHIR DevDays, Minneapolis$/,
      /, FHIR DevDays, Minneapolis$/,
      /, SNOMED CT Expo, Atlanta$/,
      /, SNOMED CT Expo, Lisbon$/,
      /, SNOMED CT Expo, online$/,
      /, FHIR DevDays, Amsterdam$/,
      /, FHIR DevDays, Amsterdam$/,
    ]);
  });

  test("lists the selected open source software", async ({ page }) => {
    // The heading names the list as open source, and the projects appear in
    // the order chosen for the CV.
    const list = page.locator("#open-source-heading + ul");
    await expect(page.locator("#open-source-heading")).toHaveText(
      "Open source software",
    );
    await expect(list.locator("cite")).toHaveText([
      "Pathling",
      "MCP FHIR Tools",
      "FHIR Terminology Encoder",
      "SQL on FHIR views for Microsoft SQL Server",
      "Signet",
      "ECL Builder",
      "FHIR Auth Java",
      "Mojoflow",
      "MCP JS Debugger",
      "JiveDrive",
      "Rangler",
      "Prana Bindu",
    ]);
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
  test("sets body text in self-hosted IBM Plex Serif", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    const family = await page
      .locator("#profile p")
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).toMatch(/^"IBM Plex Serif"/);
    // Every face the page uses must load from the site, not silently fall
    // back: regular body text, the medium name, semibold entry headings,
    // italic roles and the sans labels.
    const loaded = await page.evaluate(() =>
      [...document.fonts]
        .filter((f) => f.status === "loaded")
        .map((f) => `${f.family.replace(/"/g, "")} ${f.weight} ${f.style}`),
    );
    expect(loaded).toEqual(
      expect.arrayContaining([
        "IBM Plex Serif 400 normal",
        "IBM Plex Serif 500 normal",
        "IBM Plex Serif 600 normal",
        "IBM Plex Serif 400 italic",
        "IBM Plex Sans 400 normal",
        "IBM Plex Sans 600 normal",
      ]),
    );
  });

  test("sets labels such as dates in IBM Plex Sans with tabular figures", async ({
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
    expect(date.family).toMatch(/^"IBM Plex Sans"/);
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

  test("uses three text sizes on screen: the name, body text and labels", async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    const sizes = await page.evaluate(() => {
      const found = new Set<string>();
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement!;
        if (n.textContent!.trim() && el.checkVisibility()) {
          found.add(getComputedStyle(el).fontSize);
        }
      }
      return [...found];
    });
    expect(sizes).toHaveLength(3);
  });

  test("sets the profile at the same size as other body text", async ({
    page,
  }) => {
    await page.goto("/");
    const size = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).fontSize);
    expect(await size("#profile p")).toBe(
      await size("#selected-work .entry > p:not(.role)"),
    );
  });

  test("sets section labels in full capitals at the label size", async ({
    page,
  }) => {
    await page.goto("/");
    // Plex has no small capitals, so the browser would shrink and thin them.
    const style = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((el) => {
          const s = getComputedStyle(el);
          return {
            size: s.fontSize,
            caps: s.fontVariantCaps,
            transform: s.textTransform,
          };
        });
    const label = await style("main h2");
    const date = await style("#experience .dates");
    expect(label.caps).toBe("normal");
    expect(label.transform).toBe("uppercase");
    expect(label.size).toBe(date.size);
  });

  test("aligns side-by-side text on a common baseline", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    const offsets = await page.evaluate(() => {
      // An empty inline-block sits on the baseline of the line it is placed
      // in, so its bottom edge gives the baseline of the first line of text.
      const baseline = (el: Element) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let text = walker.nextNode();
        while (text && !text.textContent!.trim()) text = walker.nextNode();
        const mark = document.createElement("span");
        mark.style.display = "inline-block";
        text!.parentNode!.insertBefore(mark, text);
        const y = mark.getBoundingClientRect().bottom;
        mark.remove();
        return y;
      };
      const pairs: [string, Element, Element][] = [];
      for (const s of document.querySelectorAll("main > section")) {
        pairs.push([s.id, s.querySelector("h2")!, s.querySelector(".body")!]);
      }
      for (const h of document.querySelectorAll(".entry-head")) {
        pairs.push([
          h.textContent!.trim().slice(0, 20),
          h.querySelector("h3")!,
          h.querySelector(".dates")!,
        ]);
      }
      for (const d of document.querySelectorAll(".skills div")) {
        pairs.push([
          d.querySelector("dt")!.textContent!,
          d.querySelector("dt")!,
          d.querySelector("dd")!,
        ]);
      }
      return pairs.map(
        ([name, a, b]) => [name, Math.abs(baseline(a) - baseline(b))] as const,
      );
    });
    for (const [name, offset] of offsets) {
      expect(offset, name).toBeLessThan(0.5);
    }
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
// Motion
// ---------------------------------------------------------------------------

/**
 * Pauses the headline mark's spin and reads how far the mark is turned about
 * its vertical axis at each of the given fractions of the spin's duration.
 * The spin is left paused at the last fraction.
 *
 * @param page - The Playwright page showing the CV.
 * @param fractions - Points in the spin, from 0 (start) to just short of 1
 *   (end).
 * @returns The spin's duration in milliseconds, the turn at each fraction in
 *   degrees between -180 and 180, and whether the vertical axis stayed in
 *   place at every fraction; or null if the mark is not spinning.
 * @example
 * // The turn at the start and half way through the spin.
 * const { angles } = (await markSpin(page, [0, 0.5]))!;
 */
const markSpin = async (page: Page, fractions: number[]) =>
  page.locator(".mark svg").evaluate((mark, fractions) => {
    const [spin] = mark.getAnimations();
    if (!spin) return null;
    spin.pause();
    const duration = Number(spin.effect!.getComputedTiming().endTime);
    let vertical = true;
    const angles = fractions.map((fraction) => {
      spin.currentTime = duration * fraction;
      const m = new DOMMatrix(getComputedStyle(mark).transform);
      // Turning about the vertical axis leaves that axis where it was.
      vertical &&= [m.m21, m.m22 - 1, m.m23, m.m24].every(
        (value) => Math.abs(value) < 1e-4,
      );
      return (Math.atan2(-m.m13, m.m11) * 180) / Math.PI;
    });
    return { duration, angles, vertical };
  }, fractions);

/**
 * Adds up successive readings of the mark's turn, which wrap at half a turn,
 * into the total turned since the first reading.
 *
 * @param angles - Readings in degrees, each less than half a turn on from
 *   the one before.
 * @returns The degrees turned at each reading, starting from zero.
 * @example
 * turned([0, 170, -20]); // [0, 170, 340]
 */
const turned = (angles: number[]) => {
  let total = 0;
  return angles.map((angle, i) => {
    if (i > 0) total += ((angle - angles[i - 1] + 540) % 360) - 180;
    return total;
  });
};

/**
 * Measures how far an angle is from the nearest half turn. The mark is
 * symmetrical, so it looks the same after every half turn.
 *
 * @param angle - An angle in degrees.
 * @returns The distance to the nearest multiple of 180 degrees.
 */
const fromHalfTurn = (angle: number) =>
  Math.abs(angle - Math.round(angle / 180) * 180);

/**
 * Reports whether the headline mark is in motion.
 *
 * @param page - The Playwright page showing the CV.
 * @returns True if an animation is running on the mark.
 */
const markSpinning = async (page: Page) =>
  page
    .locator(".mark svg")
    .evaluate((mark) =>
      mark.getAnimations().some((spin) => spin.playState === "running"),
    );

test.describe("motion", () => {
  test("spins the mark about its vertical axis, fast then slowing to rest, when the pointer moves onto it", async ({
    page,
  }) => {
    await page.goto("/");
    // The mark is still until the pointer arrives.
    expect(await markSpinning(page)).toBe(false);
    await page.locator(".mark").hover();
    // Two hundred readings, so that the fastest part of the spin moves much
    // less than half a turn between one reading and the next.
    const spin = await markSpin(
      page,
      Array.from({ length: 201 }, (_, i) => (i / 200) * 0.999),
    );
    expect(spin).not.toBeNull();
    // It turns like a coin on its edge, not like a wheel.
    expect(spin!.vertical).toBe(true);
    const total = turned(spin!.angles);
    const [quarter, half, threeQuarters, end] = [50, 100, 150, 200].map(
      (i) => total[i],
    );
    expect(spin!.angles[0]).toBeCloseTo(0);
    // A few turns, ending face on so the mark rests as it started.
    expect(end).toBeGreaterThan(719);
    expect(fromHalfTurn(end)).toBeLessThan(1);
    // Most of the turning happens early.
    expect(quarter).toBeGreaterThan(end / 2);
    // Each quarter of the spin turns the mark less than the one before.
    const quarters = [
      quarter,
      half - quarter,
      threeQuarters - half,
      end - threeQuarters,
    ];
    for (let i = 1; i < quarters.length; i++) {
      expect(quarters[i], `quarter ${i + 1}`).toBeLessThan(quarters[i - 1]);
    }
    // Once the spin ends the mark stays still, even with the pointer still
    // on it.
    const transform = await page.locator(".mark svg").evaluate((mark) => {
      mark.getAnimations()[0].finish();
      return getComputedStyle(mark).transform;
    });
    expect(transform).toBe("none");
    expect(await markSpinning(page)).toBe(false);
  });

  test("keeps the mark spinning after the pointer leaves it", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(".mark").hover();
    await page.mouse.move(0, 0);
    expect(await markSpinning(page)).toBe(true);
  });

  test("returns the mark to full speed, without a jump, when the pointer comes back mid-spin", async ({
    page,
  }) => {
    // Reads the mark's turn at a point in the spin and its speed there, in
    // degrees per millisecond, over a short stretch that follows.
    const stretch = 0.002;
    const reading = async (fraction: number) => {
      const { duration, angles } = (await markSpin(page, [
        fraction,
        fraction + stretch,
      ]))!;
      return {
        from: angles[0],
        to: angles[1],
        speed: turned(angles)[1] / (stretch * duration),
      };
    };
    await page.goto("/");
    await page.locator(".mark").hover();
    const full = await reading(0);
    // Well into the spin the mark has slowed. The spin stays paused here, so
    // the turn it has reached when the pointer comes back is known.
    const slowed = await reading(0.6);
    expect(slowed.speed).toBeLessThan(full.speed / 2);
    await page.mouse.move(0, 0);
    await page.locator(".mark").hover();
    const restarted = await reading(0);
    // The mark carries on from where it was, and as fast as a fresh spin.
    expect(fromHalfTurn(restarted.from - slowed.to)).toBeLessThan(1);
    expect(Math.abs(restarted.speed / full.speed - 1)).toBeLessThan(0.05);
    // It still comes to rest face on.
    const { angles } = (await markSpin(page, [0.999]))!;
    expect(fromHalfTurn(angles[0])).toBeLessThan(1);
  });

  test("responds across the whole of the mark's place while the mark is edge on", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(".mark").hover();
    // Pause the spin a quarter turn in, when the mark is first edge on and
    // covers almost none of the space it rests in.
    const fractions = Array.from({ length: 201 }, (_, i) => (i / 200) * 0.05);
    const { angles } = (await markSpin(page, fractions))!;
    const edgeOn = fractions[angles.findIndex((angle) => angle >= 90)];
    await markSpin(page, [edgeOn]);
    // The pointer comes back near the left edge of that space, where the
    // mark would be if it were face on. A new spin replaces the paused one.
    await page.mouse.move(0, 0);
    await page.locator(".mark").hover({ position: { x: 1, y: 7 } });
    expect(await markSpinning(page)).toBe(true);
  });

  test("keeps the mark still when the pointer is on the headline text", async ({
    page,
  }) => {
    await page.goto("/");
    // The first word of the headline, well clear of the mark.
    await page.locator(".headline").hover({ position: { x: 10, y: 10 } });
    expect(await markSpinning(page)).toBe(false);
  });

  test("keeps the mark still for readers who prefer reduced motion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.locator(".mark").hover();
    expect(await markSpinning(page)).toBe(false);
  });

  test("spins the mark when the page is opened from disk, without a server", async ({
    page,
  }) => {
    // Browsers refuse to load some kinds of script from file: addresses.
    await page.goto(pathToFileURL(join(__dirname, "..", "index.html")).href);
    await page.locator(".mark").hover();
    expect(await markSpinning(page)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

test.describe("print", () => {
  test("prints to no more than three A4 pages", async ({ page }) => {
    await page.goto("/");
    const pages = await printPages(page);
    expect(pages.length).toBeLessThanOrEqual(3);
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
