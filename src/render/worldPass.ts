import type { Grid } from '../sim/grid';
import type { WaterSim } from '../sim/water';
import type { Camera } from './camera';
import {
  type FloatTexture,
  Uniforms,
  createFloatTexture,
  createFullscreenTriangle,
  createProgram,
  uploadFloatTexture,
  uploadFloatTextureRegion,
} from './gl';

/**
 * Draws the whole world - terrain and water - in one fullscreen pass.
 *
 * Terrain and water live in two textures and are composited in the fragment
 * shader, so the entire river costs a single draw call regardless of how big
 * the level is. Nothing is rasterised per-cell.
 */

const VERTEX_SOURCE = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vClip;
void main() {
  vClip = aPos;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 vClip;
out vec4 fragColor;

uniform sampler2D uTerrain;   // R: ground height in metres
uniform sampler2D uWater;     // R: depth, G/B: velocity

uniform vec2 uCamera;         // world position at screen centre
uniform vec2 uHalfExtent;     // half the visible world size, in metres
uniform vec2 uWorldSize;      // level size in metres
uniform vec2 uTexel;          // 1 / grid dimensions
uniform float uCellSize;
uniform float uTime;
uniform float uMinDepth;
uniform float uShowGrid;      // editor affordance: 1 to draw contour lines

const vec3 SUN = normalize(vec3(-0.55, -0.72, 0.42));

// --- procedural value noise -------------------------------------------------

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/**
 * Sample ripple noise advected along the flow.
 *
 * A texture scrolled along a velocity field stretches without bound, so this
 * uses the standard flow-map trick: two copies of the noise, offset half a
 * cycle apart in time, cross-faded so whichever copy is showing is always near
 * the middle of its life and has drifted only a little.
 */
float flowNoise(vec2 p, vec2 vel, float t) {
  float phase0 = fract(t);
  float phase1 = fract(t + 0.5);
  float blend = abs(2.0 * phase0 - 1.0);
  float a = valueNoise(p - vel * phase0);
  float b = valueNoise(p - vel * phase1);
  return mix(a, b, blend);
}

// --- terrain ----------------------------------------------------------------

vec3 terrainColour(float h) {
  // Hypsometric ramp: river gravel through meadow to bare rock.
  vec3 gravel = vec3(0.62, 0.55, 0.40);
  vec3 grassLow = vec3(0.31, 0.44, 0.24);
  vec3 grassHigh = vec3(0.42, 0.49, 0.28);
  vec3 rock = vec3(0.47, 0.45, 0.42);
  vec3 scree = vec3(0.68, 0.66, 0.62);

  vec3 c = mix(gravel, grassLow, smoothstep(1.5, 5.0, h));
  c = mix(c, grassHigh, smoothstep(5.0, 14.0, h));
  c = mix(c, rock, smoothstep(15.0, 26.0, h));
  c = mix(c, scree, smoothstep(28.0, 38.0, h));
  return c;
}

void main() {
  // Clip space is y-up, the world is y-down, hence the flip on y.
  vec2 world = uCamera + vec2(vClip.x, -vClip.y) * uHalfExtent;
  vec2 uv = world / uWorldSize;

  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
    // Outside the level: a flat void, slightly vignetted towards the edges.
    fragColor = vec4(0.055, 0.065, 0.085, 1.0);
    return;
  }

  float h = texture(uTerrain, uv).r;

  // Ground normal from central differences. Horizontal spacing is one cell in
  // metres, so the slope is in real units and the lighting reads as terrain.
  float hL = texture(uTerrain, uv - vec2(uTexel.x, 0.0)).r;
  float hR = texture(uTerrain, uv + vec2(uTexel.x, 0.0)).r;
  float hD = texture(uTerrain, uv - vec2(0.0, uTexel.y)).r;
  float hU = texture(uTerrain, uv + vec2(0.0, uTexel.y)).r;
  vec3 normal = normalize(vec3((hL - hR) / (2.0 * uCellSize), (hD - hU) / (2.0 * uCellSize), 1.0));

  // Micro-relief. A 2 m cell covers tens of screen pixels when zoomed in, and
  // the heightmap is smooth at that scale, so shading it alone gives a blurred
  // green wash. Procedural detail in world space costs nothing to store and
  // stays put as the camera moves.
  //
  // The two octaves are rotated relative to each other. Value noise is
  // separable, so its features line up with the axes; a single octave of it
  // laid over open ground reads unmistakably as woven fabric. Rotating the
  // second octave breaks up that grain.
  const mat2 TURN = mat2(0.80, -0.60, 0.60, 0.80);
  vec2 p1 = world * 0.9;
  vec2 p2 = TURN * world * 2.7;
  float g0 = valueNoise(p1);
  float gx = valueNoise(p1 + vec2(0.3, 0.0));
  float gy = valueNoise(p1 + vec2(0.0, 0.3));
  float fine = valueNoise(p2);

  // Gentle: this is meant to suggest texture underfoot, not corrugate the map.
  normal = normalize(normal + vec3((g0 - gx) * 0.5, (g0 - gy) * 0.5, 0.0));

  float lambert = max(dot(normal, SUN), 0.0);
  float ambient = 0.45 + 0.15 * normal.z;
  vec3 colour = terrainColour(h) * (ambient + 0.75 * lambert);
  // Mottling, so flat ground isn't a single flat colour.
  colour *= 0.95 + 0.06 * g0 + 0.04 * fine;

  // Contour lines make height legible while sculpting.
  if (uShowGrid > 0.5) {
    float contour = fract(h * 0.5);
    float line = smoothstep(0.0, 0.06, contour) * smoothstep(0.12, 0.06, contour);
    colour = mix(colour, colour * 0.72, line * 0.7);
  }

  // --- water ---------------------------------------------------------------

  vec3 water = texture(uWater, uv).rgb;
  float depth = water.r;

  if (depth > uMinDepth) {
    vec2 vel = water.gb;
    float speed = length(vel);

    // Ripples ride the current. Scale is in metres so they stay the same
    // physical size as the camera zooms.
    vec2 p = world * 0.85;
    vec2 drift = vel * 0.55;
    float t = uTime * 0.55;

    float n = flowNoise(p, drift, t);
    float nx = flowNoise(p + vec2(0.35, 0.0), drift, t);
    float ny = flowNoise(p + vec2(0.0, 0.35), drift, t);

    // Faster water is choppier.
    float chop = 0.35 + min(speed * 0.55, 1.4);
    vec3 rippleNormal = normalize(vec3((n - nx) * chop, (n - ny) * chop, 0.22));

    // Deep water is darker and less transparent.
    float t2 = 1.0 - exp(-depth * 1.5);
    vec3 shallowTint = vec3(0.36, 0.62, 0.66);
    vec3 deepTint = vec3(0.06, 0.20, 0.38);
    vec3 waterColour = mix(shallowTint, deepTint, t2);

    // Let the riverbed show through shallow water.
    float opacity = clamp(0.30 + t2 * 0.72, 0.0, 0.94);

    // Broad and soft. A tight exponent on a noisy normal turns every ripple
    // crest into an isolated white dot, which reads as confetti on the water
    // rather than light on a moving surface.
    float spec = pow(max(dot(rippleNormal, SUN), 0.0), 8.0);
    // A dark rim where water meets land reads as a wet bank.
    float shore = smoothstep(uMinDepth, uMinDepth + 0.28, depth);

    // Whitewater: fast flow, and standing waves where fast water runs shallow.
    float foamSpeed = smoothstep(1.2, 3.0, speed);
    float foamShallow = foamSpeed * (1.0 - smoothstep(0.10, 0.55, depth));
    float foam = clamp(foamSpeed * 0.55 + foamShallow * 0.85, 0.0, 1.0);
    // Gate on a wide band of the ripple field so foam forms streaks along the
    // flow instead of speckles.
    foam *= smoothstep(0.30, 0.72, n);

    vec3 wet = mix(colour * 0.72, waterColour, opacity);
    wet += spec * 0.20;
    wet = mix(wet, vec3(0.92, 0.95, 0.97), foam * 0.8);

    colour = mix(colour, wet, shore);
  }

  fragColor = vec4(colour, 1.0);
}`;

export class WorldPass {
  private program: WebGLProgram;
  private uniforms: Uniforms;
  private vao: WebGLVertexArrayObject;
  private terrainTex: FloatTexture;
  private waterTex: FloatTexture;
  /** Interleaved depth/vx/vy for upload, rebuilt each frame. */
  private waterBuffer: Float32Array;
  private patchScratch: Float32Array;

  constructor(
    private gl: WebGL2RenderingContext,
    private grid: Grid,
  ) {
    this.program = createProgram(gl, VERTEX_SOURCE, FRAGMENT_SOURCE);
    this.uniforms = new Uniforms(gl, this.program);
    this.vao = createFullscreenTriangle(gl);
    this.terrainTex = createFloatTexture(gl, grid.width, grid.height, 1);
    this.waterTex = createFloatTexture(gl, grid.width, grid.height, 4);
    this.waterBuffer = new Float32Array(grid.width * grid.height * 4);
    this.patchScratch = new Float32Array(1024);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteTexture(this.terrainTex.texture);
    this.gl.deleteTexture(this.waterTex.texture);
  }

  uploadTerrain(terrain: Float32Array): void {
    uploadFloatTexture(this.gl, this.terrainTex, terrain);
  }

  /** Upload just the rect a brush touched, so sculpting doesn't re-send the map. */
  uploadTerrainRegion(
    terrain: Float32Array,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): void {
    uploadFloatTextureRegion(this.gl, this.terrainTex, terrain, x0, y0, x1, y1, this.patchScratch);
  }

  private uploadWater(sim: WaterSim): void {
    const { depth, vx, vy } = sim;
    const buf = this.waterBuffer;
    for (let i = 0, j = 0; i < depth.length; i++, j += 4) {
      buf[j] = depth[i];
      buf[j + 1] = vx[i];
      buf[j + 2] = vy[i];
    }
    uploadFloatTexture(this.gl, this.waterTex, buf);
  }

  draw(sim: WaterSim, camera: Camera, time: number, showGrid: boolean): void {
    const gl = this.gl;
    this.uploadWater(sim);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.terrainTex.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.waterTex.texture);

    const u = this.uniforms;
    u.i1('uTerrain', 0);
    u.i1('uWater', 1);
    u.f2('uCamera', camera.x, camera.y);
    u.f2(
      'uHalfExtent',
      camera.viewWidth / 2 / camera.zoom,
      camera.viewHeight / 2 / camera.zoom,
    );
    u.f2('uWorldSize', this.grid.width * this.grid.cellSize, this.grid.height * this.grid.cellSize);
    u.f2('uTexel', 1 / this.grid.width, 1 / this.grid.height);
    u.f1('uCellSize', this.grid.cellSize);
    u.f1('uTime', time);
    u.f1('uMinDepth', sim.params.minDepth);
    u.f1('uShowGrid', showGrid ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}
