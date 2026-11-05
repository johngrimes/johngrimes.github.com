/**
 * Turns input into a smoothed viewpoint offset for the scene background.
 *
 * On devices that can hover, the offset follows the pointer: its position
 * across the window maps to -1 (left or top edge) to 1 (right or bottom edge)
 * on each axis, and the offset returns to rest when the pointer leaves the
 * window. On touch screens, which cannot hover, scrolling moves the viewpoint
 * down from rest (y = 0 at the top of the page) to y = 1 at the bottom. With
 * reduced motion requested, the offset stays at rest.
 *
 * @author John Grimes
 */

// Time constant (seconds) of the easing towards the latest target.
const EASING = 0.18;

// Distance from the target below which the offset snaps to it and stops. At
// the largest parallax this is well under a tenth of a pixel.
const SETTLE = 1e-3;

// Longest time (seconds) a single frame may advance the easing, so slow
// renderers settle in few frames without jumping after the tab was hidden.
const LONGEST_FRAME = 0.25;

/**
 * Starts listening for pointer and scroll input.
 *
 * @param {(offset: {x: number, y: number}) => void} onChange - Called on each
 *   animation frame while the offset moves, with x and y in [-1, 1].
 * @returns {void}
 * @example
 * createMotion(({ x, y }) => view.move({ x, y }));
 */
export function createMotion(onChange) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const hover = matchMedia("(hover: hover)");
  const target = { x: 0, y: 0 };
  const current = { x: 0, y: 0 };
  let frame = 0;
  let last = 0;

  /**
   * Eases the offset one frame towards its goal and reports it, scheduling
   * another frame until the offset settles.
   *
   * @param {DOMHighResTimeStamp} time - Time of this animation frame.
   * @returns {void}
   */
  const step = (time) => {
    const dt = last ? Math.min((time - last) / 1000, LONGEST_FRAME) : 1 / 60;
    last = time;
    const goal = reduce.matches ? { x: 0, y: 0 } : target;
    const k = 1 - Math.exp(-dt / EASING);
    current.x += (goal.x - current.x) * k;
    current.y += (goal.y - current.y) * k;
    const settled =
      Math.abs(goal.x - current.x) < SETTLE &&
      Math.abs(goal.y - current.y) < SETTLE;
    if (settled) {
      current.x = goal.x;
      current.y = goal.y;
    }
    onChange({ x: current.x, y: current.y });
    frame = settled ? 0 : requestAnimationFrame(step);
    if (settled) {
      last = 0;
    }
  };

  /**
   * Starts easing on the next animation frame, unless already easing.
   *
   * @returns {void}
   */
  const wake = () => {
    if (!frame) {
      frame = requestAnimationFrame(step);
    }
  };

  /**
   * Sets the offset to ease towards, clamped to [-1, 1]. With reduced motion
   * the target is kept for later, but nothing moves or redraws.
   *
   * @param {number} x - Horizontal target offset.
   * @param {number} y - Vertical target offset.
   * @returns {void}
   */
  const aim = (x, y) => {
    target.x = Math.max(-1, Math.min(1, x));
    target.y = Math.max(-1, Math.min(1, y));
    if (!reduce.matches) {
      wake();
    }
  };

  addEventListener("pointermove", (event) => {
    if (hover.matches && event.pointerType !== "touch") {
      aim(
        (event.clientX / innerWidth) * 2 - 1,
        (event.clientY / innerHeight) * 2 - 1,
      );
    }
  });
  document.documentElement.addEventListener("pointerleave", () => {
    if (hover.matches) {
      aim(0, 0);
    }
  });

  /**
   * Measures scroll progress down the page.
   *
   * @returns {number} 0 at the top of the page and 1 at the bottom.
   */
  const scrolled = () => {
    const range = document.documentElement.scrollHeight - innerHeight;
    return range > 0 ? scrollY / range : 0;
  };
  addEventListener(
    "scroll",
    () => {
      if (!hover.matches) {
        aim(0, scrolled());
      }
    },
    { passive: true },
  );

  // Start where the page already is, without easing in: at rest for a
  // pointer, or at the restored scroll position on a touch screen.
  if (!hover.matches && !reduce.matches) {
    current.y = target.y = scrolled();
    onChange({ x: current.x, y: current.y });
  }
  // Ease to rest when reduced motion is turned on, and back to the latest
  // target when it is turned off.
  reduce.addEventListener("change", wake);
}
