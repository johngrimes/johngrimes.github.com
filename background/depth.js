/**
 * The depth variant of the scene background: the whole scene as one image
 * plus a disparity map, redrawn by a WebGL2 fragment shader for each
 * viewpoint. Each pixel ray-marches the disparity map to find the scene
 * point that the parallax shift brings under it, so near objects slide over
 * far ones around the fixed focal plane. The canvas is drawn only when the
 * viewpoint or the viewport changes, so the page is idle otherwise. Without
 * WebGL2 the view falls back to the still image.
 *
 * @author John Grimes
 */

// Highest device pixel ratio the canvas is rendered at.
const MAX_PIXEL_RATIO = 1.5;

// Number of steps of the ray-march from the near to the far disparity, and
// of bisection steps that refine the first hit.
const STEPS = 32;
const REFINE = 5;

// Covers the viewport with one triangle and passes on each pixel's position
// in frame widths from the centre of the frame, with y down.
const VERTEX = `#version 300 es
uniform vec2 halfView;
out vec2 frame;

void main() {
  vec2 clip = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  frame = vec2(clip.x, -clip.y) * halfView;
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;

// Finds the scene point q0 whose parallax shift lands it on this pixel, by
// marching over disparity from near to far, so that the nearest such point
// wins, and then bisecting between the last miss and the first hit.
const FRAGMENT = `#version 300 es
precision highp float;

uniform sampler2D colour;
uniform sampler2D depth;
// Size of the render in frame widths.
uniform vec2 render;
// focal * baseline * offset: the shift of a point is shift * (1/focus - 1/z).
uniform vec2 shift;
// 1/focus, 1/near - 1/far and 1/far.
uniform vec3 disparity;
in vec2 frame;
out vec4 fragColour;

const int STEPS = ${STEPS};
const int REFINE = ${REFINE};

// Texture coordinates of a point in frame widths from the frame centre.
vec2 uv(vec2 q) {
  return q / render + 0.5;
}

// The scene point that lands on this pixel if its disparity is w.
vec2 source(float w) {
  return frame - shift * (disparity.x - w);
}

// Whether the scene at the source of disparity w is at least that near.
bool hits(float w) {
  float d = textureLod(depth, uv(source(w)), 0.0).r;
  return d * disparity.y + disparity.z >= w;
}

void main() {
  float far = disparity.z;
  float near = disparity.y + far;
  float step = disparity.y / float(STEPS);
  float hit = near;
  float miss = near;
  for (int i = 0; i <= STEPS; i++) {
    hit = max(near - float(i) * step, far);
    if (hits(hit)) {
      break;
    }
    miss = hit;
  }
  for (int i = 0; i < REFINE; i++) {
    float middle = 0.5 * (hit + miss);
    if (hits(middle)) {
      hit = middle;
    } else {
      miss = middle;
    }
  }
  fragColour = vec4(textureLod(colour, uv(source(hit)), 0.0).rgb, 1.0);
}
`;

/**
 * Loads the scene image and disparity map for a colour scheme, draws the
 * scene into a WebGL2 canvas in the container and returns a view that
 * redraws it for each viewpoint. Falls back to the still scene image if
 * WebGL2 is unavailable or setup fails.
 *
 * @param {HTMLElement} container - The backdrop element to draw into.
 * @param {object} options - What to draw.
 * @param {object} options.manifest - The parsed scene.json.
 * @param {URL} options.assets - URL of background/assets/, with a trailing
 *   slash.
 * @param {"light" | "dark"} options.scheme - The colour scheme to draw.
 * @returns {Promise<{state: "ready" | "fallback", move: (offset: {x: number,
 *   y: number}) => void, unmount: () => void}>} The view, once the first
 *   frame is drawn.
 * @throws {Error} If the fallback image fails to load or decode.
 * @example
 * const view = await mount(backdrop, { manifest, assets, scheme: "light" });
 * view.move({ x: 0.5, y: -0.2 });
 */
export async function mount(container, { manifest, assets, scheme }) {
  const colourUrl = new URL(`${scheme}/colour.webp`, assets);
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  const program = gl && createProgram(gl);
  if (!program) {
    release(gl);
    return still(container, manifest, colourUrl);
  }
  const textures = await Promise.all([
    loadTexture(gl, colourUrl, gl.RGB8, gl.RGB, "default"),
    loadTexture(gl, new URL("depth.webp", assets), gl.R8, gl.RED, "none"),
  ]).catch((error) => {
    console.warn("Could not set up the scene textures", error);
    return null;
  });
  if (!textures) {
    release(gl);
    return still(container, manifest, colourUrl);
  }

  const { aspect, overscan, focal, baseline, focus, near, far } = manifest;
  const uniform = (name) => gl.getUniformLocation(program, name);
  gl.useProgram(program);
  textures.forEach((texture, unit) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  });
  gl.uniform1i(uniform("colour"), 0);
  gl.uniform1i(uniform("depth"), 1);
  gl.uniform2f(uniform("render"), 1 + 2 * overscan, 1 / aspect + 2 * overscan);
  gl.uniform3f(uniform("disparity"), 1 / focus, 1 / near - 1 / far, 1 / far);
  const shift = uniform("shift");
  const halfView = uniform("halfView");
  let offset = { x: 0, y: 0 };

  /**
   * Draws the scene for an offset.
   *
   * @param {{x: number, y: number}} next - Offset in [-1, 1] on each axis.
   * @returns {void}
   */
  const move = (next) => {
    offset = next;
    gl.uniform2f(shift, focal * baseline * next.x, focal * baseline * next.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  /**
   * Sizes the canvas to the container and redraws the last offset.
   *
   * @returns {void}
   */
  const resize = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    const scale = Math.max(width, height * aspect);
    const ratio = Math.min(devicePixelRatio, MAX_PIXEL_RATIO);
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(halfView, width / 2 / scale, height / 2 / scale);
    move(offset);
  };

  resize();
  container.append(canvas);
  addEventListener("resize", resize);
  gl.finish();

  return {
    state: "ready",
    move,
    unmount: () => {
      removeEventListener("resize", resize);
      canvas.remove();
      release(gl);
    },
  };
}

/**
 * Compiles and links the scene shaders.
 *
 * @param {WebGL2RenderingContext} gl - The context to compile in.
 * @returns {WebGLProgram | null} The linked program, or null if compiling
 *   or linking failed.
 */
function createProgram(gl) {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, VERTEX],
    [gl.FRAGMENT_SHADER, FRAGMENT],
  ]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
    return program;
  }
  const logs = gl
    .getAttachedShaders(program)
    ?.map((shader) => gl.getShaderInfoLog(shader));
  console.warn(
    "Could not build the scene shaders",
    gl.getProgramInfoLog(program),
    logs,
  );
  return null;
}

/**
 * Fetches and decodes an image and uploads it as a texture with linear
 * filtering, clamped at the edges.
 *
 * @param {WebGL2RenderingContext} gl - The context to upload to.
 * @param {URL} url - The image to load.
 * @param {number} internalFormat - The sized format of the texture.
 * @param {number} format - The format of the uploaded pixels.
 * @param {"default" | "none"} colorSpaceConversion - Whether to colour
 *   manage the image, which a data texture must not be.
 * @returns {Promise<WebGLTexture>} The texture.
 * @throws {Error} If the image fails to load or decode, or the upload fails.
 */
async function loadTexture(
  gl,
  url,
  internalFormat,
  format,
  colorSpaceConversion,
) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load ${url}: ${response.status}`);
  }
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion,
    premultiplyAlpha: "none",
  });
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    internalFormat,
    format,
    gl.UNSIGNED_BYTE,
    bitmap,
  );
  bitmap.close();
  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    throw new Error(`Could not upload ${url}: GL error ${error}`);
  }
  return texture;
}

/**
 * Releases a WebGL context and everything in it.
 *
 * @param {WebGL2RenderingContext | null} gl - The context, if any.
 * @returns {void}
 */
function release(gl) {
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
}

/**
 * Shows the still scene image, fitted like the full render, as the fallback
 * view.
 *
 * @param {HTMLElement} container - The backdrop element to draw into.
 * @param {object} manifest - The parsed scene.json.
 * @param {URL} url - The scene image for the colour scheme.
 * @returns {Promise<{state: "fallback", move: () => void, unmount: () =>
 *   void}>} The view, once the image is decoded.
 * @throws {Error} If the image fails to load or decode.
 */
async function still(container, { aspect, overscan }, url) {
  const image = new Image();
  image.alt = "";
  image.decoding = "async";
  image.src = url.href;
  await image.decode();

  /**
   * Sizes the image to cover the container and centres it in it.
   *
   * @returns {void}
   */
  const fit = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    const scale = Math.max(width, height * aspect);
    const w = (1 + 2 * overscan) * scale;
    const h = (1 / aspect + 2 * overscan) * scale;
    Object.assign(image.style, {
      width: `${w}px`,
      height: `${h}px`,
      left: `${(width - w) / 2}px`,
      top: `${(height - h) / 2}px`,
    });
  };

  fit();
  container.append(image);
  addEventListener("resize", fit);

  return {
    state: "fallback",
    move: () => {},
    unmount: () => {
      removeEventListener("resize", fit);
      image.remove();
    },
  };
}
