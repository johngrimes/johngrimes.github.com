/**
 * Spins the headline mark about its vertical axis, like a coin on its edge,
 * when the pointer enters the headline. The spin starts at full speed and
 * slows to rest face on, whether or not the pointer stays. If the pointer
 * comes back before the mark has stopped, the spin starts again at full speed
 * from wherever the mark has reached.
 *
 * @author John Grimes
 */

// A spin from rest: four turns over two and a half seconds, slowing
// throughout.
const TURNS = 4;
const DURATION = 2500;
const EASING = "cubic-bezier(0.33, 1, 0.68, 1)";

// Distance to the viewer. The closer it is, the more the near edge of the
// turning mark grows and the far edge shrinks.
const PERSPECTIVE = "4em";

const headline = document.querySelector(".headline");
const mark = headline.querySelector(".mark");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// The latest spin, and the angles in degrees that it runs between.
let spin = null;
let from = 0;
let to = 0;

headline.addEventListener("mouseenter", () => {
  if (reducedMotion.matches) return;
  // A spin that has finished reports no progress, and leaves the mark at rest.
  const progress = spin?.effect.getComputedTiming().progress ?? null;
  // The mark is symmetrical and looks the same after every half turn, so only
  // its position within the current half turn carries over.
  from = progress === null ? 0 : (from + (to - from) * progress) % 180;
  // Stop face on, at the first half turn that is at least a full spin away.
  to = Math.ceil(from / 180) * 180 + TURNS * 360;
  spin?.cancel();
  spin = mark.animate(
    {
      transform: [from, to].map(
        (angle) => `perspective(${PERSPECTIVE}) rotateY(${angle}deg)`,
      ),
    },
    // A longer spin lasts longer in proportion, so that every spin starts at
    // the same speed.
    { duration: (DURATION * (to - from)) / (TURNS * 360), easing: EASING },
  );
});
