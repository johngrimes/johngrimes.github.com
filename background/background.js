/**
 * Draws the 3D scene behind the CV, in one of three variants chosen with the
 * bg query parameter: layers (the default), depth or gltf.
 *
 * The backdrop element reports its state for tests and debugging:
 * data-variant names the variant, data-scheme the colour scheme drawn, and
 * data-state is "loading", then "ready" once the first frame is drawn, or
 * "fallback" when the variant has fallen back to a still image. Nothing is
 * fetched until the page has finished loading, so the scene never competes
 * with the CV itself. When the colour scheme changes, the scene is redrawn
 * for the new scheme, and the old one stays until the new one is ready.
 *
 * Each variant module exports `mount(container, { manifest, assets, scheme })`,
 * which resolves to a view `{ state, move(offset), unmount() }` once drawn.
 *
 * @author John Grimes
 */

import { createMotion } from "./motion.js";

const VARIANTS = ["layers", "depth", "gltf"];
const ASSETS = new URL("assets/", import.meta.url);

const requested = new URLSearchParams(location.search).get("bg");
const variant = VARIANTS.includes(requested) ? requested : "layers";

const backdrop = document.createElement("div");
backdrop.className = "backdrop";
backdrop.setAttribute("aria-hidden", "true");
backdrop.dataset.variant = variant;
backdrop.dataset.state = "loading";
document.body.prepend(backdrop);

/**
 * Loads the manifest and the variant, draws the scene for the current colour
 * scheme, and redraws it whenever the scheme changes.
 *
 * @returns {Promise<void>}
 * @throws {Error} If the manifest or the variant module fails to load.
 */
async function start() {
  const response = await fetch(new URL("scene.json", ASSETS));
  if (!response.ok) {
    throw new Error(`Could not load the scene manifest: ${response.status}`);
  }
  const manifest = await response.json();
  const { mount } = await import(`./${variant}.js`);
  const dark = matchMedia("(prefers-color-scheme: dark)");
  let view = null;
  let offset = { x: 0, y: 0 };
  let generation = 0;

  /**
   * Draws the scene for the current colour scheme, then replaces the view
   * drawn for the previous one.
   *
   * @returns {Promise<void>}
   * @throws {Error} If the variant fails to draw.
   */
  const show = async () => {
    const mine = ++generation;
    const scheme = dark.matches ? "dark" : "light";
    const next = await mount(backdrop, { manifest, assets: ASSETS, scheme });
    if (mine !== generation) {
      // A newer scheme change overtook this one.
      next.unmount();
      return;
    }
    next.move(offset);
    view?.unmount();
    view = next;
    backdrop.dataset.scheme = scheme;
    backdrop.dataset.state = next.state;
  };

  createMotion((moved) => {
    offset = moved;
    view?.move(moved);
  });
  dark.addEventListener("change", show);
  await show();
}

const loaded =
  document.readyState === "complete"
    ? Promise.resolve()
    : new Promise((resolve) =>
        addEventListener("load", resolve, { once: true }),
      );

loaded.then(start).catch((error) => {
  backdrop.dataset.state = "error";
  console.error(error);
});
