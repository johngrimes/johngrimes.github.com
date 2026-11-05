/**
 * Entry point for vendoring three.js: re-exports only what the glTF variant
 * of the scene background uses, so that `bun run vendor:three` can bundle it
 * into the single self-contained module background/three.js.
 *
 * @author John Grimes
 */

export {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  LinearSRGBColorSpace,
  Mesh,
  OrthographicCamera,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
} from "three";
export { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
