/**
 * The glTF variant of the scene background: renders the model in scene.glb
 * live with WebGL2, so that parallax comes from moving a real camera.
 *
 * Every surface is shaded with a simple Lambert model (a uniform sky plus the
 * sun) and mapped straight onto the scheme's palette, as the other variants
 * have it baked in. A fixed-focus depth of field then blurs the mapped image,
 * averaging palette colours only. The scene is drawn only when the view
 * moves or the window is resized, never in a loop. Without WebGL2, or if
 * setup fails, the view falls back to the still image of the whole scene.
 *
 * @author John Grimes
 */

// Highest device pixel ratio rendered, to bound the cost on dense screens.
const MAX_PIXEL_RATIO = 1.5;

// Shares of the sky's and the sun's strength that reach the surfaces. They
// stand in for the occlusion, shadows and bounce light of the path-traced
// render, in which most of the room lies in the shade of its roof. Fitted
// against colour.webp on the floor, ceiling, walls and bench fronts.
const SKY_SHARE = 0.4;
const SUN_SHARE = 0.1;

// Sky light reaching a surface facing straight down, relative to one facing
// straight up.
const GROUND = 0.38;

// Diameter (m) of the lens aperture of the rendered camera: f/0.12 on a
// 16 mm lens. A point at depth z is blurred into a disc of diameter
// focal * APERTURE * |1/focus - 1/z| frame widths.
const APERTURE = 0.016 / 0.12;

// Largest blur radius in frame widths, reached at about 1.5 m.
const MAX_BLUR = 0.016;

// Approximate number of samples the blur takes for each pixel.
const BLUR_SAMPLES = 160;

// Multisampling of the scene render, for smooth edges.
const SAMPLES = 4;

const SCENE_VERTEX = /* glsl */ `
  varying vec3 vPosition;
  varying vec3 vNormal;
  varying float vDepth;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec4 view = viewMatrix * world;
    vPosition = world.xyz;
    vNormal = transpose(inverse(mat3(modelMatrix))) * normal;
    vDepth = -view.z;
    gl_Position = projectionMatrix * view;
  }
`;

// Writes the palette colour, and in alpha the remoteness 1 - 1/z (z in
// metres along the camera axis, clamped to at least 1 m) for the depth of
// field pass. Empty sky is cleared to paper with remoteness 1.
const SCENE_FRAGMENT = /* glsl */ `
  uniform float albedo;
  uniform bool emissive;
  uniform float sky;
  uniform float ground;
  uniform vec3 sunDirection;
  uniform float sun;
  uniform float exposure;
  uniform vec2 fog;
  uniform vec3 paper;
  uniform vec3 extreme;
  uniform float shadow;
  uniform float lit;

  varying vec3 vPosition;
  varying vec3 vNormal;
  varying float vDepth;

  float srgbEncode(float c) {
    return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
  }

  void main() {
    vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    float irradiance = sky * mix(ground, 1.0, 0.5 + 0.5 * n.y)
      + sun * max(dot(n, sunDirection), 0.0) / 3.14159265;
    float v = emissive
      ? 1.0
      : srgbEncode(clamp(exposure * albedo * irradiance, 0.0, 1.0));
    float r = distance(vPosition, cameraPosition);
    float presence = 1.0 - smoothstep(fog.x, fog.y, r);
    float ink = presence * (shadow + (lit - shadow) * v);
    gl_FragColor = vec4(
      paper + (extreme - paper) * ink,
      1.0 - min(1.0 / vDepth, 1.0)
    );
  }
`;

const BLUR_VERTEX = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Gathers each pixel's neighbours on a golden-angle spiral, counting a
// neighbour when its own blur disc reaches this pixel, so blurred foreground
// spreads over sharp background but not the other way round. Every output is
// an average of palette colours, so it stays on the paper to extreme segment.
const BLUR_FRAGMENT = /* glsl */ `
  uniform sampler2D image;
  uniform vec2 texel;
  uniform float inverseFocus;
  uniform float radiusScale;
  uniform float maxRadius;
  uniform float spacing;

  varying vec2 vUv;

  const float GOLDEN_ANGLE = 2.39996323;

  float blurRadius(float remoteness) {
    float inverseDepth = 1.0 - remoteness;
    return min(radiusScale * abs(inverseFocus - inverseDepth), maxRadius);
  }

  void main() {
    vec4 centre = texture2D(image, vUv);
    float centreRadius = blurRadius(centre.a);
    vec3 colour = centre.rgb;
    float total = 1.0;
    float radius = spacing;
    for (int i = 0; i < 1024; i++) {
      if (radius >= maxRadius) {
        break;
      }
      float angle = float(i) * GOLDEN_ANGLE;
      vec4 tap = texture2D(image, vUv + vec2(cos(angle), sin(angle)) * texel * radius);
      float tapRadius = blurRadius(tap.a);
      if (tap.a > centre.a) {
        tapRadius = min(tapRadius, 2.0 * centreRadius);
      }
      float m = smoothstep(radius - 0.5, radius + 0.5, tapRadius);
      colour += mix(colour / total, tap.rgb, m);
      total += 1.0;
      radius += spacing / radius;
    }
    gl_FragColor = vec4(colour / total, 1.0);
  }
`;

/**
 * Draws the scene into a container and keeps it in step with the viewpoint.
 *
 * @param {HTMLElement} container - The backdrop element to draw into.
 * @param {object} options - What to draw.
 * @param {object} options.manifest - The parsed scene.json.
 * @param {URL} options.assets - URL of background/assets/, with a trailing
 *   slash.
 * @param {"light" | "dark"} options.scheme - The colour scheme to draw.
 * @returns {Promise<{state: "ready" | "fallback", move: (offset: {x: number,
 *   y: number}) => void, unmount: () => void}>} The view, once its first
 *   frame is drawn.
 * @throws {Error} If neither the scene nor the still image can be shown.
 * @example
 * const view = await mount(backdrop, { manifest, assets, scheme: "light" });
 * view.move({ x: 0.5, y: -0.2 });
 * view.unmount();
 */
export async function mount(container, { manifest, assets, scheme }) {
  if (!hasWebGL2()) {
    return mountStill(container, { manifest, assets, scheme });
  }
  try {
    return await mountScene(container, { manifest, assets, scheme });
  } catch (error) {
    console.warn("Showing the still scene, as WebGL setup failed:", error);
    return mountStill(container, { manifest, assets, scheme });
  }
}

/**
 * Checks whether WebGL2 is available, using a throwaway canvas whose context
 * is released straight away.
 *
 * @returns {boolean} True if a WebGL2 context can be created.
 */
function hasWebGL2() {
  const gl = document.createElement("canvas").getContext("webgl2");
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  return Boolean(gl);
}

/**
 * Computes the cover fit of the displayed frame to a viewport.
 *
 * @param {number} width - Viewport width in CSS px.
 * @param {number} height - Viewport height in CSS px.
 * @param {number} aspect - Aspect ratio of the displayed frame.
 * @returns {number} CSS px per frame width.
 */
function coverScale(width, height, aspect) {
  return Math.max(width, height * aspect);
}

/**
 * Converts a "#rrggbb" colour to 0-1 channels.
 *
 * @param {string} hex - The colour.
 * @returns {number[]} Red, green and blue in 0-1.
 */
function channels(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

/**
 * Shows the still image of the whole scene, cover fitted like the renders.
 *
 * @param {HTMLElement} container - The backdrop element to draw into.
 * @param {object} options - What to draw.
 * @param {object} options.manifest - The parsed scene.json.
 * @param {URL} options.assets - URL of background/assets/.
 * @param {"light" | "dark"} options.scheme - The colour scheme to draw.
 * @returns {Promise<{state: "fallback", move: () => void, unmount: () =>
 *   void}>} The view, once the image is decoded.
 * @throws {Error} If the image cannot be loaded or decoded.
 */
async function mountStill(container, { manifest, assets, scheme }) {
  const { aspect, overscan } = manifest;
  const image = document.createElement("img");
  image.alt = "";
  image.src = new URL(`${scheme}/colour.webp`, assets).href;

  /**
   * Sizes the still image like the full render and centres it.
   *
   * @returns {void}
   */
  const place = () => {
    const { clientWidth, clientHeight } = container;
    const s = coverScale(clientWidth, clientHeight, aspect);
    const width = (1 + 2 * overscan) * s;
    const height = (1 / aspect + 2 * overscan) * s;
    Object.assign(image.style, {
      width: `${width}px`,
      height: `${height}px`,
      left: `${(clientWidth - width) / 2}px`,
      top: `${(clientHeight - height) / 2}px`,
    });
  };

  await image.decode();
  place();
  container.append(image);
  addEventListener("resize", place);
  return {
    state: "fallback",
    move() {},
    unmount() {
      removeEventListener("resize", place);
      image.remove();
    },
  };
}

/**
 * Loads three.js and the model, and draws the scene with WebGL2.
 *
 * @param {HTMLElement} container - The backdrop element to draw into.
 * @param {object} options - What to draw.
 * @param {object} options.manifest - The parsed scene.json.
 * @param {URL} options.assets - URL of background/assets/.
 * @param {"light" | "dark"} options.scheme - The colour scheme to draw.
 * @returns {Promise<{state: "ready", move: (offset: {x: number, y: number})
 *   => void, unmount: () => void}>} The view, once the first frame is drawn.
 * @throws {Error} If three.js or the model fails to load, or WebGL setup
 *   fails. Everything created so far is released first.
 */
async function mountScene(container, { manifest, assets, scheme }) {
  const three = await import("./three.js");
  const gltf = await new three.GLTFLoader().loadAsync(
    new URL("scene.glb", assets).href,
  );
  const scene = gltf.scene;
  const canvas = document.createElement("canvas");
  const quad = createQuad(three, manifest);
  let renderer = null;
  let target = null;
  let view = null;
  let offset = { x: 0, y: 0 };
  let size = "";

  /**
   * Releases the canvas, the GL resources and the resize listener.
   *
   * @returns {void}
   */
  const release = () => {
    removeEventListener("resize", draw);
    scene.traverse((object) => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
    quad.mesh.geometry.dispose();
    quad.mesh.material.dispose();
    target?.dispose();
    renderer?.dispose();
    renderer?.forceContextLoss();
    canvas.remove();
  };

  /**
   * Renders the scene for the latest offset, resizing the render targets
   * first if the viewport or pixel ratio has changed.
   *
   * @returns {void}
   */
  const draw = () => {
    const { clientWidth: width, clientHeight: height } = container;
    const ratio = Math.min(devicePixelRatio, MAX_PIXEL_RATIO);
    if (size !== `${width}x${height}@${ratio}`) {
      size = `${width}x${height}@${ratio}`;
      renderer.setPixelRatio(ratio);
      renderer.setSize(width, height);
      target.setSize(Math.round(width * ratio), Math.round(height * ratio));
      quad.resize(
        target.width,
        target.height,
        coverScale(width, height, manifest.aspect) * ratio,
      );
    }
    view.place(offset, width, height);
    renderer.setRenderTarget(target);
    renderer.render(scene, view.camera);
    renderer.setRenderTarget(null);
    renderer.render(quad.mesh, quad.camera);
  };

  try {
    scene.updateMatrixWorld(true);
    view = createView(three, gltf, manifest);
    shadeScene(three, scene, manifest, scheme);
    renderer = new three.WebGLRenderer({
      canvas,
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    });
    // Every shader writes palette colours as they are, with no conversion.
    renderer.outputColorSpace = three.LinearSRGBColorSpace;
    renderer.setClearColor(
      new three.Color().setRGB(
        ...channels(manifest.palette[scheme].paper),
        three.LinearSRGBColorSpace,
      ),
      1,
    );
    target = new three.WebGLRenderTarget(1, 1, { samples: SAMPLES });
    quad.mesh.material.uniforms.image.value = target.texture;
    draw();
    container.append(canvas);
    addEventListener("resize", draw);
  } catch (error) {
    release();
    throw error;
  }

  return {
    state: "ready",
    move(moved) {
      offset = moved;
      draw();
    },
    unmount: release,
  };
}

/**
 * Takes the camera from the model and sets it up to follow the viewpoint
 * with a fixed focal plane.
 *
 * @param {object} three - The three.js module.
 * @param {object} gltf - The loaded model, with world matrices up to date.
 * @param {object} manifest - The parsed scene.json.
 * @returns {{camera: object, place: (offset: {x: number, y: number}, width:
 *   number, height: number) => void}} The camera, and a function that moves
 *   it for an offset and a viewport size in CSS px.
 * @throws {Error} If the model has no camera named Camera.
 */
function createView(three, gltf, manifest) {
  const { aspect, focal, focus, baseline } = manifest;
  const camera = gltf.cameras.find((c) => c.name === "Camera");
  if (!camera) {
    throw new Error("The model has no camera named Camera");
  }
  const rest = camera.matrixWorld.clone();
  const right = new three.Vector3().setFromMatrixColumn(rest, 0);
  const up = new three.Vector3().setFromMatrixColumn(rest, 1);
  const origin = new three.Vector3().setFromMatrixPosition(rest);
  const position = new three.Vector3();
  camera.removeFromParent();
  camera.matrixAutoUpdate = false;
  camera.matrix.copy(rest);

  /**
   * Moves the camera for an offset and sets the off-axis projection that
   * keeps the focal plane still, with the displayed frame cover fitted.
   *
   * @param {{x: number, y: number}} offset - Offset in [-1, 1] on each axis.
   * @param {number} width - Viewport width in CSS px.
   * @param {number} height - Viewport height in CSS px.
   * @returns {void}
   */
  const place = ({ x, y }, width, height) => {
    // Move the camera across its own plane.
    position
      .copy(origin)
      .addScaledVector(right, baseline * x)
      .addScaledVector(up, -baseline * y);
    camera.matrix.setPosition(position);
    camera.updateMatrixWorld(true);

    // Visible half-extents of the viewport in frame widths, and the lens
    // shift that keeps the plane at the focus depth still on screen.
    const s = coverScale(width, height, aspect);
    const halfWidth = width / (2 * s);
    const halfHeight = height / (2 * s);
    const shiftX = (focal * baseline * x) / focus;
    const shiftY = (focal * -baseline * y) / focus;
    const k = camera.near / focal;
    camera.projectionMatrix.makePerspective(
      k * (-halfWidth - shiftX),
      k * (halfWidth - shiftX),
      k * (halfHeight - shiftY),
      k * (-halfHeight - shiftY),
      camera.near,
      camera.far,
    );
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  };

  return { camera, place };
}

/**
 * Replaces every material in the scene with one that shades it onto the
 * scheme's palette.
 *
 * @param {object} three - The three.js module.
 * @param {object} scene - The model's scene, with world matrices up to date.
 * @param {object} manifest - The parsed scene.json.
 * @param {"light" | "dark"} scheme - The colour scheme to draw.
 * @returns {void}
 * @throws {Error} If the model has no light named Sun.
 */
function shadeScene(three, scene, manifest, scheme) {
  const { exposure, fog, lighting } = manifest;
  const palette = manifest.palette[scheme];
  const sun = scene.getObjectByName("Sun");
  if (!sun) {
    throw new Error("The model has no light named Sun");
  }
  // A glTF light shines along its node's -z axis.
  const sunDirection = sun.getWorldDirection(new three.Vector3());
  const shared = {
    sky: { value: lighting.sky * SKY_SHARE },
    ground: { value: GROUND },
    sunDirection: { value: sunDirection },
    sun: { value: lighting.sun * SUN_SHARE },
    exposure: { value: exposure },
    fog: { value: [fog.start, fog.end] },
    paper: { value: channels(palette.paper) },
    extreme: { value: channels(palette.extreme) },
    shadow: { value: palette.shadow },
    lit: { value: palette.lit },
  };
  const replaced = new Map();
  const replace = (source) => {
    if (!replaced.has(source)) {
      replaced.set(
        source,
        new three.ShaderMaterial({
          uniforms: {
            ...shared,
            albedo: { value: source.color?.r ?? 1 },
            emissive: {
              value: (source.emissive?.getHex() ?? 0) !== 0,
            },
          },
          vertexShader: SCENE_VERTEX,
          fragmentShader: SCENE_FRAGMENT,
          side: three.DoubleSide,
        }),
      );
    }
    return replaced.get(source);
  };
  scene.traverse((object) => {
    if (object.isMesh) {
      object.material = Array.isArray(object.material)
        ? object.material.map(replace)
        : replace(object.material);
    }
  });
  replaced.forEach((_, source) => source.dispose());
}

/**
 * Creates the full-screen pass that applies the depth of field.
 *
 * @param {object} three - The three.js module.
 * @param {object} manifest - The parsed scene.json.
 * @returns {{mesh: object, camera: object, resize: (width: number, height:
 *   number, pixelsPerFrame: number) => void}} The pass, with a function that
 *   sets its blur sizes for a render target size and scale in device px.
 */
function createQuad(three, manifest) {
  const geometry = new three.BufferGeometry();
  geometry.setAttribute(
    "position",
    new three.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]),
      3,
    ),
  );
  const material = new three.ShaderMaterial({
    uniforms: {
      image: { value: null },
      texel: { value: [1, 1] },
      inverseFocus: { value: 1 / manifest.focus },
      radiusScale: { value: 0 },
      maxRadius: { value: 0 },
      spacing: { value: 0.5 },
    },
    vertexShader: BLUR_VERTEX,
    fragmentShader: BLUR_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new three.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const { uniforms } = material;

  return {
    mesh,
    camera: new three.OrthographicCamera(),
    resize(width, height, pixelsPerFrame) {
      const maxRadius = MAX_BLUR * pixelsPerFrame;
      uniforms.texel.value = [1 / width, 1 / height];
      uniforms.radiusScale.value =
        0.5 * manifest.focal * APERTURE * pixelsPerFrame;
      uniforms.maxRadius.value = maxRadius;
      // The spiral takes about maxRadius^2 / (2 * spacing) samples.
      uniforms.spacing.value = Math.max(
        0.5,
        (maxRadius * maxRadius) / (2 * BLUR_SAMPLES),
      );
    },
  };
}
