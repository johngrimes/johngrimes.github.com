/**
 * Behavioural tests for the 3D scene background: variant selection, asset
 * loading, pointer and scroll motion, colour schemes, legibility of the text
 * over the scene, fallbacks and print.
 *
 * @author John Grimes
 */

import { devices, expect, test, type Page } from "@playwright/test";

const VARIANTS = ["layers", "depth", "gltf"] as const;
type Variant = (typeof VARIANTS)[number];

// The code and assets that belong to each variant. A variant must request
// all of its own and none of the others'.
const OWN: Record<Variant, RegExp[]> = {
  layers: [
    /\/background\/layers\.js$/,
    /\/background\/assets\/(light|dark)\/layer-\d+\.webp$/,
  ],
  depth: [
    /\/background\/depth\.js$/,
    /\/background\/assets\/depth\.webp$/,
    /\/background\/assets\/(light|dark)\/colour\.webp$/,
  ],
  gltf: [
    /\/background\/gltf\.js$/,
    /\/background\/three\.js$/,
    /\/background\/assets\/scene\.glb$/,
  ],
};

// WCAG 2 AA minimum contrast for body-sized text.
const AA = 4.5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Opens the page with an optional variant and waits until the background has
 * drawn its first frame or settled on its still fallback.
 *
 * @param page - The Playwright page.
 * @param variant - Value for the `bg` query parameter, if any.
 */
async function open(page: Page, variant?: string): Promise<void> {
  await page.goto(variant === undefined ? "/" : `/?bg=${variant}`);
  await expect(page.locator(".backdrop")).toHaveAttribute(
    "data-state",
    /^(ready|fallback)$/,
  );
}

/**
 * Records the pathname of every request the page makes.
 *
 * @param page - The Playwright page.
 * @returns A live array of request pathnames.
 */
function recordRequests(page: Page): string[] {
  const paths: string[] = [];
  page.on("request", (r) => paths.push(new URL(r.url()).pathname));
  return paths;
}

/**
 * Hides everything except the background, so screenshots show the scene
 * alone.
 *
 * @param page - The Playwright page.
 */
async function hideContent(page: Page): Promise<void> {
  await page.addStyleTag({
    content: "body > :not(.backdrop) { visibility: hidden !important; }",
  });
}

/**
 * Takes screenshots until two in a row are identical, so that any easing
 * towards a new pointer or scroll position has finished.
 *
 * @param page - The Playwright page.
 * @returns The settled screenshot as PNG bytes.
 * @throws If the page is still changing after five seconds.
 */
async function settledShot(page: Page): Promise<Buffer> {
  let previous = await page.screenshot();
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(100);
    const next = await page.screenshot();
    if (next.equals(previous)) {
      return next;
    }
    previous = next;
  }
  throw new Error("The background did not settle within five seconds");
}

/**
 * Computes the lowest contrast ratio between a text colour and any pixel of
 * a screenshot, using the WCAG 2 relative luminance formula.
 *
 * @param page - Any page, used to decode the PNG in the browser.
 * @param png - The screenshot.
 * @param text - The text colour as a CSS colour string.
 * @returns The minimum contrast ratio over all pixels.
 */
async function minContrast(
  page: Page,
  png: Buffer,
  text: string,
): Promise<number> {
  return page.evaluate(
    async ({ data, text }) => {
      const channel = (c: number) => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (r: number, g: number, b: number) =>
        0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      const [tr, tg, tb] = text.match(/\d+/g)!.map(Number);
      const lt = luminance(tr, tg, tb);
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      let lowest = Infinity;
      for (let i = 0; i < pixels.length; i += 4) {
        const lb = luminance(pixels[i], pixels[i + 1], pixels[i + 2]);
        const ratio = (Math.max(lt, lb) + 0.05) / (Math.min(lt, lb) + 0.05);
        lowest = Math.min(lowest, ratio);
      }
      return lowest;
    },
    { data: png.toString("base64"), text },
  );
}

// ---------------------------------------------------------------------------
// Variant selection
// ---------------------------------------------------------------------------

test.describe("variant selection", () => {
  test("uses the layered variant when no variant is requested", async ({
    page,
  }) => {
    await open(page);
    await expect(page.locator(".backdrop")).toHaveAttribute(
      "data-variant",
      "layers",
    );
  });

  test("uses the layered variant for an unknown bg value", async ({ page }) => {
    await open(page, "nonsense");
    await expect(page.locator(".backdrop")).toHaveAttribute(
      "data-variant",
      "layers",
    );
  });

  for (const variant of VARIANTS) {
    test(`draws the ${variant} variant when requested with ?bg=${variant}`, async ({
      page,
    }) => {
      await open(page, variant);
      const backdrop = page.locator(".backdrop");
      await expect(backdrop).toHaveAttribute("data-variant", variant);
      // WebGL is available in the test browser, so no variant should need
      // its still fallback here.
      await expect(backdrop).toHaveAttribute("data-state", "ready");
    });

    test(`loads only the ${variant} variant's code and assets`, async ({
      page,
    }) => {
      const requests = recordRequests(page);
      await open(page, variant);
      const mine = OWN[variant];
      const others = VARIANTS.filter((v) => v !== variant).flatMap(
        (v) => OWN[v],
      );
      for (const pattern of mine) {
        expect(requests.some((path) => pattern.test(path))).toBe(true);
      }
      const foreign = requests.filter(
        (path) =>
          others.some((p) => p.test(path)) && !mine.some((p) => p.test(path)),
      );
      expect(foreign).toEqual([]);
    });

    test(`makes no requests outside the site's own origin with ?bg=${variant}`, async ({
      page,
      baseURL,
    }) => {
      const requests: string[] = [];
      page.on("request", (r) => requests.push(r.url()));
      await open(page, variant);
      expect(requests.filter((url) => !url.startsWith(`${baseURL}/`))).toEqual(
        [],
      );
    });

    test(`starts loading the ${variant} scene only after the page has loaded`, async ({
      page,
    }) => {
      await open(page, variant);
      const timing = await page.evaluate(() => {
        const [navigation] = performance.getEntriesByType(
          "navigation",
        ) as PerformanceNavigationTiming[];
        // The loader and its input handling are part of the page; everything
        // the scene itself needs must wait for the page to finish loading.
        const scene = performance
          .getEntriesByType("resource")
          .filter((e) =>
            /^\/background\/(?!background\.js$|motion\.js$)/.test(
              new URL(e.name).pathname,
            ),
          )
          .map((e) => e.startTime);
        return { load: navigation.loadEventStart, scene };
      });
      expect(timing.scene.length).toBeGreaterThan(0);
      for (const start of timing.scene) {
        expect(start).toBeGreaterThanOrEqual(timing.load);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Colour schemes
// ---------------------------------------------------------------------------

test.describe("colour schemes", () => {
  for (const variant of ["layers", "depth"] as const) {
    for (const [scheme, other] of [
      ["light", "dark"],
      ["dark", "light"],
    ] as const) {
      test(`downloads only the ${scheme} assets in ${scheme} mode with ?bg=${variant}`, async ({
        page,
      }) => {
        const requests = recordRequests(page);
        await page.emulateMedia({ colorScheme: scheme });
        await open(page, variant);
        await expect(page.locator(".backdrop")).toHaveAttribute(
          "data-scheme",
          scheme,
        );
        expect(
          requests.some((p) => p.startsWith(`/background/assets/${scheme}/`)),
        ).toBe(true);
        expect(
          requests.filter((p) => p.startsWith(`/background/assets/${other}/`)),
        ).toEqual([]);
      });
    }
  }

  for (const variant of VARIANTS) {
    test(`redraws the ${variant} scene when the colour scheme changes`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: "light" });
      await open(page, variant);
      await hideContent(page);
      const light = await settledShot(page);
      await page.emulateMedia({ colorScheme: "dark" });
      const backdrop = page.locator(".backdrop");
      await expect(backdrop).toHaveAttribute("data-scheme", "dark");
      await expect(backdrop).toHaveAttribute("data-state", "ready");
      const dark = await settledShot(page);
      expect(dark.equals(light)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

test.describe("motion with a mouse", () => {
  for (const variant of VARIANTS) {
    test(`moves the ${variant} scene when the pointer moves`, async ({
      page,
    }) => {
      await open(page, variant);
      await hideContent(page);
      await page.mouse.move(640, 360);
      const centre = await settledShot(page);
      await page.mouse.move(5, 5);
      const corner = await settledShot(page);
      expect(corner.equals(centre)).toBe(false);
    });

    test(`keeps the ${variant} scene still when reduced motion is requested`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await open(page, variant);
      await hideContent(page);
      await page.mouse.move(640, 360);
      const centre = await settledShot(page);
      await page.mouse.move(5, 5);
      const corner = await settledShot(page);
      expect(corner.equals(centre)).toBe(true);
    });

    test(`ignores scrolling with a mouse in the ${variant} scene`, async ({
      page,
    }) => {
      await open(page, variant);
      await hideContent(page);
      const top = await settledShot(page);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const bottom = await settledShot(page);
      expect(bottom.equals(top)).toBe(true);
    });
  }

  test("moves near layers against far layers around the focal plane", async ({
    page,
  }) => {
    await open(page, "layers");
    // Horizontal centre of each layer, first at rest and then with the
    // pointer at the right edge.
    const centres: number[][] = [];
    for (const x of [640, 1275]) {
      await page.mouse.move(x, 360);
      await settledShot(page);
      centres.push(
        await page.locator(".backdrop img").evaluateAll((images) =>
          images.map((img) => {
            const r = img.getBoundingClientRect();
            return r.left + r.width / 2;
          }),
        ),
      );
    }
    const [rest, moved] = centres;
    // Layers are ordered farthest first. Moving the pointer right moves the
    // viewpoint right, so the far scene shifts right and the near scene left.
    expect(moved[0] - rest[0]).toBeGreaterThan(0);
    expect(moved.at(-1)! - rest.at(-1)!).toBeLessThan(0);
  });

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
  ]) {
    test(`keeps every layer covering a ${viewport.width}x${viewport.height} viewport at the extremes of motion`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await open(page, "layers");
      for (const [x, y] of [
        [0, 0],
        [viewport.width - 1, viewport.height - 1],
      ]) {
        await page.mouse.move(x, y);
        await settledShot(page);
        const rects = await page
          .locator(".backdrop img")
          .evaluateAll((images) =>
            images.map((img) => img.getBoundingClientRect().toJSON()),
          );
        expect(rects.length).toBeGreaterThan(1);
        for (const r of rects) {
          expect(r.left).toBeLessThanOrEqual(0);
          expect(r.top).toBeLessThanOrEqual(0);
          expect(r.right).toBeGreaterThanOrEqual(viewport.width);
          expect(r.bottom).toBeGreaterThanOrEqual(viewport.height);
        }
      }
    });
  }
});

test.describe("motion on a touch screen", () => {
  // Phone emulation gives a coarse pointer with no hover, as on real phones.
  const { defaultBrowserType: _, ...phone } = devices["Pixel 7"];
  test.use(phone);

  for (const variant of VARIANTS) {
    test(`moves the ${variant} scene when the page scrolls`, async ({
      page,
    }) => {
      await open(page, variant);
      await hideContent(page);
      const top = await settledShot(page);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const bottom = await settledShot(page);
      expect(bottom.equals(top)).toBe(false);
    });
  }

  test("ignores pointer movement on a touch screen", async ({ page }) => {
    await open(page, "layers");
    await hideContent(page);
    const before = await settledShot(page);
    await page.mouse.move(5, 5);
    const after = await settledShot(page);
    expect(after.equals(before)).toBe(true);
  });

  test("keeps the scene still on scroll when reduced motion is requested", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, "layers");
    await hideContent(page);
    const top = await settledShot(page);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const bottom = await settledShot(page);
    expect(bottom.equals(top)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Legibility
// ---------------------------------------------------------------------------

test.describe("legibility", () => {
  for (const variant of VARIANTS) {
    for (const colorScheme of ["light", "dark"] as const) {
      test(`keeps AA contrast for muted text over every pixel of the ${variant} scene in ${colorScheme} mode`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme });
        await open(page, variant);
        // Muted text has the least contrast with the paper in both schemes.
        const muted = await page
          .locator(".dates")
          .first()
          .evaluate((el) => getComputedStyle(el).color);
        await hideContent(page);
        for (const [x, y] of [
          [640, 360],
          [0, 0],
          [1279, 719],
        ]) {
          await page.mouse.move(x, y);
          const shot = await settledShot(page);
          expect(await minContrast(page, shot, muted)).toBeGreaterThanOrEqual(
            AA,
          );
        }
      });
    }
  }

  for (const variant of VARIANTS) {
    test(`keeps links clickable over the ${variant} scene`, async ({
      page,
    }) => {
      await open(page, variant);
      const backdrop = page.locator(".backdrop");
      await expect(backdrop).toHaveAttribute("aria-hidden", "true");
      const link = page.locator("header .contact a").first();
      const box = (await link.boundingBox())!;
      const hit = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest("a")?.href,
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      );
      expect(hit).toBe(await link.evaluate((a: HTMLAnchorElement) => a.href));
    });
  }
});

// ---------------------------------------------------------------------------
// Fallbacks and print
// ---------------------------------------------------------------------------

test.describe("fallbacks", () => {
  for (const variant of ["depth", "gltf"] as const) {
    test(`shows a still image of the scene when WebGL is unavailable with ?bg=${variant}`, async ({
      page,
    }) => {
      await page.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (
          this: HTMLCanvasElement,
          type: string,
          ...rest: unknown[]
        ) {
          return /webgl/.test(type)
            ? null
            : (original as (...a: unknown[]) => unknown).call(
                this,
                type,
                ...rest,
              );
        } as typeof original;
      });
      await open(page, variant);
      const backdrop = page.locator(".backdrop");
      await expect(backdrop).toHaveAttribute("data-state", "fallback");
      const still = backdrop.locator("img");
      await expect(still).toHaveAttribute(
        "src",
        /background\/assets\/light\/colour\.webp$/,
      );
      expect(
        await still.evaluate((img: HTMLImageElement) => img.naturalWidth),
      ).toBeGreaterThan(0);
    });
  }

  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });

    for (const colorScheme of ["light", "dark"] as const) {
      test(`shows the still ${colorScheme} scene`, async ({ page }) => {
        // The browser fetches a pseudo-element's background image once it
        // has laid the page out, which can be after the load event.
        const still = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname ===
            `/background/assets/${colorScheme}/colour.webp`,
        );
        await page.emulateMedia({ colorScheme });
        await page.goto("/");
        expect((await still).ok()).toBe(true);
      });
    }
  });

  test("hides the background when printing", async ({ page }) => {
    await open(page);
    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".backdrop")).toBeHidden();
  });
});
