import * as THREE from 'three';
import { FullScreenQuad } from './vendor/three/Pass.js';

/* ============================================================== *
 *  celkit — the reusable half of the sakura-crossing 3D-to-2D
 *  technique: cel material, inverted-hull outlines, and the ink +
 *  grade post pipeline. Scene content (geometry, layout, palette)
 *  stays in each demo; only the rendering machinery lives here.
 * ============================================================== */

const rampCache = new Map();
export function gradientMap(bands = 3) {
  if (rampCache.has(bands)) return rampCache.get(bands);
  const stopsByBand = { 2: [96, 255], 3: [92, 178, 255], 4: [80, 142, 202, 255] };
  const stops = stopsByBand[bands] || stopsByBand[3];
  const data = new Uint8Array(stops.length * 4);
  stops.forEach((v, i) => { data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255; });
  const tex = new THREE.DataTexture(data, stops.length, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  rampCache.set(bands, tex);
  return tex;
}

// Patches three's toon BRDF so the shadow band is hue-shifted toward a
// cool tint rather than just a darker version of the lit colour — that
// shift is most of what reads as "anime cel" instead of "low-poly 3D".
const TOON_CHUNK = 'lights_toon_pars_fragment';
const TOON_LINE = 'vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color;';
const TOON_PATCH = `
  vec3 celBand = getGradientIrradiance( geometryNormal, directLight.direction );
  vec3 irradiance = celBand * mix( uShadowTint, vec3( 1.0 ), celBand ) * directLight.color;`;

let patchedChunk = null;
{
  const src = THREE.ShaderChunk[TOON_CHUNK];
  if (src && src.includes(TOON_LINE)) {
    patchedChunk = 'uniform vec3 uShadowTint;\n' + src.replace(TOON_LINE, TOON_PATCH);
  }
}

export function cel(color, { bands = 3, tint = 0x6c5f8c, map = null, alphaMap = null, transparent = false, side = THREE.FrontSide } = {}) {
  const mat = new THREE.MeshToonMaterial({ color, gradientMap: gradientMap(bands), flatShading: true, map, alphaMap, transparent, side });
  if (patchedChunk) {
    const uni = { value: new THREE.Color(tint) };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uShadowTint = uni;
      shader.fragmentShader = shader.fragmentShader.replace(`#include <${TOON_CHUNK}>`, patchedChunk);
    };
    mat.customProgramCacheKey = () => 'cel_' + new THREE.Color(tint).getHexString() + (map ? '_m' : '') + (alphaMap ? '_a' : '');
  }
  return mat;
}

/** Unlit flat colour — for glass, distant silhouettes, glowing panels. */
export function flat(color, { map = null, transparent = false, opacity = 1, side = THREE.FrontSide } = {}) {
  return new THREE.MeshBasicMaterial({ color, map, transparent, opacity, side });
}

/**
 * Inverted-hull outline: a back-faced shell pushed out along the normal
 * in clip space, so a hero object keeps a constant pixel-width contour
 * at any distance, independent of the screen-space ink pass.
 */
export function hullOutline(mesh, thickness = 0.045, color = 0x39324f) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uThickness: { value: thickness }, uColor: { value: new THREE.Color(color) } },
    vertexShader: `
      uniform float uThickness;
      void main() {
        vec3 n = normalize( normalMatrix * normal );
        vec4 clip = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        vec3 clipN = normalize( ( projectionMatrix * vec4( n, 0.0 ) ).xyz );
        clip.xy += clipN.xy * uThickness * clip.w * 0.5;
        gl_Position = clip;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      void main() { gl_FragColor = vec4( uColor, 1.0 ); }`,
    side: THREE.BackSide,
  });
  const shell = new THREE.Mesh(mesh.geometry, mat);
  shell.renderOrder = -1;
  mesh.add(shell);
  return shell;
}

/* ============================================================== *
 *  Post pipeline: scene -> (colour + depth) -> ink pass (2nd
 *  difference of linear depth) -> grade pass (split-tone + sRGB)
 *  -> screen.
 * ============================================================== */
const INK_SHADER = {
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() },
    uNear: { value: 0.1 }, uFar: { value: 200 }, uInk: { value: new THREE.Color(0x39324f) },
    uThickness: { value: 1.4 }, uSens: { value: 0.0042 }, uConcave: { value: 0.026 }, uConcaveAmount: { value: 0.42 },
    uFadeStart: { value: 30.0 }, uFadeEnd: { value: 65.0 }, uStrength: { value: 1.0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    #include <packing>
    uniform sampler2D tDiffuse, tDepth;
    uniform vec2 uTexel;
    uniform float uNear, uFar, uThickness, uSens, uConcave, uConcaveAmount, uFadeStart, uFadeEnd, uStrength;
    uniform vec3 uInk;
    varying vec2 vUv;
    float linearDepth(vec2 uv){ float d = texture2D(tDepth, uv).x; return -perspectiveDepthToViewZ(d, uNear, uFar); }
    void main(){
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      vec2 t = uTexel * uThickness;
      float dc = linearDepth(vUv);
      float dl = linearDepth(vUv - vec2(t.x,0.0));
      float dr = linearDepth(vUv + vec2(t.x,0.0));
      float du = linearDepth(vUv + vec2(0.0,t.y));
      float dd = linearDepth(vUv - vec2(0.0,t.y));
      float sx = (dl + dr - 2.0*dc) / dc;
      float sy = (du + dd - 2.0*dc) / dc;
      float convex = max(0.0, sx) + max(0.0, sy);
      float concave = max(0.0, -sx) + max(0.0, -sy);
      float edge = smoothstep(uSens*0.32, uSens, convex);
      edge = max(edge, smoothstep(uConcave, uConcave*3.4, concave) * uConcaveAmount);
      edge *= 1.0 - smoothstep(uFadeStart, uFadeEnd, dc);
      edge *= uStrength;
      vec3 line = mix(uInk, col * 0.42, 0.22);
      gl_FragColor = vec4(mix(col, line, clamp(edge, 0.0, 1.0)), 1.0);
    }`,
};

const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uShadowTint: { value: new THREE.Color(0xada8d0) }, uLightTint: { value: new THREE.Color(0xfff7e8) },
    uSaturation: { value: 1.12 }, uLift: { value: 0.032 }, uVignette: { value: 0.15 },
    uEnabled: { value: 1 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec3 uShadowTint, uLightTint;
    uniform float uSaturation, uLift, uVignette, uEnabled;
    varying vec2 vUv;
    vec3 linearToSRGB(vec3 c){ return mix(c*12.92, 1.055*pow(max(c,vec3(0.0031308)),vec3(1.0/2.4))-0.055, step(0.0031308,c)); }
    void main(){
      vec3 raw = texture2D(tDiffuse, vUv).rgb;
      vec3 c = raw;
      float l = dot(c, vec3(0.2126,0.7152,0.0722));
      float k = smoothstep(0.02, 0.55, l);
      c *= mix(uShadowTint, uLightTint, k);
      c = c + uLift * (1.0 - k);
      c = mix(vec3(l), c, uSaturation);
      float r = length(vUv - 0.5) * 1.42;
      c *= 1.0 - uVignette * pow(clamp(r,0.0,1.0), 2.6);
      c = linearToSRGB(max(c, vec3(0.0)));
      // still convert linear->sRGB when grading is off, or the un-graded
      // toggle would come out washed out next to the graded one
      vec3 rawSRGB = linearToSRGB(max(raw, vec3(0.0)));
      gl_FragColor = vec4(mix(rawSRGB, c, uEnabled), 1.0);
    }`,
};

function makeQuad(def) {
  const mat = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(def.uniforms), vertexShader: def.vertexShader, fragmentShader: def.fragmentShader, depthTest: false, depthWrite: false });
  return { quad: new FullScreenQuad(mat), mat };
}

export class Pipeline {
  constructor(renderer, scene, camera, { inkColor = 0x39324f, shadowTint = 0xada8d0, lightTint = 0xfff7e8 } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    const rtOpts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true, colorSpace: THREE.NoColorSpace };
    this.rtScene = new THREE.WebGLRenderTarget(2, 2, rtOpts);
    this.rtScene.depthTexture = new THREE.DepthTexture(2, 2);
    this.rtScene.depthTexture.format = THREE.DepthFormat;
    this.rtScene.depthTexture.type = THREE.UnsignedIntType;
    this.rtScene.depthTexture.minFilter = this.rtScene.depthTexture.magFilter = THREE.NearestFilter;
    this.rtA = new THREE.WebGLRenderTarget(2, 2, { ...rtOpts, depthBuffer: false });

    this.ink = makeQuad(INK_SHADER);
    this.grade = makeQuad(GRADE_SHADER);
    this.ink.mat.uniforms.tDepth.value = this.rtScene.depthTexture;
    this.ink.mat.uniforms.uInk.value = new THREE.Color(inkColor);
    this.grade.mat.uniforms.uShadowTint.value = new THREE.Color(shadowTint);
    this.grade.mat.uniforms.uLightTint.value = new THREE.Color(lightTint);

    this.enabled = { ink: true, grade: true };
  }

  setSize(w, h) {
    const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const rw = Math.floor(w * scale), rh = Math.floor(h * scale);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, true);
    this.rtScene.setSize(rw, rh);
    this.rtA.setSize(rw, rh);
    this.ink.mat.uniforms.uTexel.value.set(1 / rw, 1 / rh);
    this.ink.mat.uniforms.uNear.value = this.camera.near;
    this.ink.mat.uniforms.uFar.value = this.camera.far;
  }

  render() {
    const r = this.renderer;
    r.setRenderTarget(this.rtScene);
    r.clear();
    r.render(this.scene, this.camera);

    let src = this.rtScene.texture;
    if (this.enabled.ink) {
      this.ink.mat.uniforms.tDiffuse.value = src;
      r.setRenderTarget(this.rtA);
      this.ink.quad.render(r);
      src = this.rtA.texture;
    }
    this.grade.mat.uniforms.tDiffuse.value = src;
    this.grade.mat.uniforms.uEnabled.value = this.enabled.grade ? 1 : 0;
    r.setRenderTarget(null);
    this.grade.quad.render(r);
  }
}
