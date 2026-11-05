/**
 * The layered variant of the scene background: the scene pre-rendered as a
 * stack of flat depth slices, farthest first, each shifted by the parallax of
 * its representative depth. Moving a layer only changes its transform, so the
 * browser can move the stack on the compositor without redrawing anything.
 *
 * @author John Grimes
 */

/**
 * Loads the layers for a colour scheme, draws them into the container and
 * returns a view that moves them with the viewpoint.
 *
 * @param {HTMLElement} container - The backdrop element to draw into.
 * @param {object} options - What to draw.
 * @param {object} options.manifest - The parsed scene.json.
 * @param {URL} options.assets - URL of background/assets/, with a trailing
 *   slash.
 * @param {"light" | "dark"} options.scheme - The colour scheme to draw.
 * @returns {Promise<{state: "ready", move: (offset: {x: number, y: number}) =>
 *   void, unmount: () => void}>} The view, once every layer is decoded.
 * @throws {Error} If a layer fails to load or decode.
 * @example
 * const view = await mount(backdrop, { manifest, assets, scheme: "light" });
 * view.move({ x: 0.5, y: -0.2 });
 */
export async function mount(container, { manifest, assets, scheme }) {
  const { aspect, overscan, focal, baseline, focus, layers } = manifest;
  // Shift of each layer in frame widths per unit of offset.
  const shifts = layers.map(
    ({ depth }) => focal * baseline * (1 / focus - 1 / depth),
  );
  const images = layers.map((_, i) => {
    const image = new Image();
    image.alt = "";
    image.decoding = "async";
    image.src = new URL(`${scheme}/layer-${i}.webp`, assets).href;
    return image;
  });
  await Promise.all(images.map((image) => image.decode()));

  let scale = 0;
  let offset = { x: 0, y: 0 };

  /**
   * Moves each layer by its parallax shift for an offset.
   *
   * @param {{x: number, y: number}} next - Offset in [-1, 1] on each axis.
   * @returns {void}
   */
  const move = (next) => {
    offset = next;
    images.forEach((image, i) => {
      const shift = shifts[i] * scale;
      image.style.transform = `translate3d(${shift * next.x}px, ${shift * next.y}px, 0)`;
    });
  };

  /**
   * Sizes the layers to cover the container and centres them in it.
   *
   * @returns {void}
   */
  const fit = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    scale = Math.max(width, height * aspect);
    const w = (1 + 2 * overscan) * scale;
    const h = (1 / aspect + 2 * overscan) * scale;
    for (const image of images) {
      Object.assign(image.style, {
        width: `${w}px`,
        height: `${h}px`,
        left: `${(width - w) / 2}px`,
        top: `${(height - h) / 2}px`,
      });
    }
  };

  /**
   * Refits the layers to a resized viewport and restores the last offset.
   *
   * @returns {void}
   */
  const resize = () => {
    fit();
    move(offset);
  };

  resize();
  container.append(...images);
  addEventListener("resize", resize);

  return {
    state: "ready",
    move,
    unmount: () => {
      removeEventListener("resize", resize);
      images.forEach((image) => image.remove());
    },
  };
}
