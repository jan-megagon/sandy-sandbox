import type { Camera } from './camera';
import { Uniforms, createProgram } from './gl';

/**
 * Draws the handful of objects that sit on top of the river.
 *
 * Every shape is an analytic distance field evaluated in the fragment shader,
 * so there are no textures or sprite atlases to load and everything stays
 * crisp at any zoom. There are only ever a few dozen of these, so each gets
 * its own small draw call rather than an instancing setup.
 */

export const Shape = {
  Kayak: 0,
  Goal: 1,
  Rock: 2,
  Source: 3,
  Ring: 4,
  Start: 5,
} as const;

export type ShapeId = (typeof Shape)[keyof typeof Shape];

const VERTEX_SOURCE = `#version 300 es
layout(location = 0) in vec2 aCorner;

uniform vec2 uCamera;
uniform vec2 uHalfExtent;
uniform vec2 uPos;
uniform vec2 uSize;
uniform float uRot;

out vec2 vLocal;

void main() {
  vLocal = aCorner;
  float c = cos(uRot);
  float s = sin(uRot);
  vec2 r = vec2(aCorner.x * c - aCorner.y * s, aCorner.x * s + aCorner.y * c);
  vec2 world = uPos + r * uSize;
  vec2 clip = (world - uCamera) / uHalfExtent;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 vLocal;
out vec4 fragColor;

uniform int uShape;
uniform vec4 uColour;
uniform float uTime;
uniform float uParam;   // shape-specific: stroke flash, health, ring width

/** Coverage from a signed distance, antialiased against the pixel footprint. */
float cover(float d) {
  float w = fwidth(d) * 0.9 + 1e-5;
  return smoothstep(w, -w, d);
}

void main() {
  vec2 p = vLocal;
  vec4 col = uColour;
  float alpha = 0.0;

  if (uShape == 0) {
    // Kayak: a pointed hull, long axis along +x.
    float k = 1.0 - p.x * p.x;
    if (k <= 0.0) discard;
    float ry = 0.42 * pow(k, 0.40);
    float hull = abs(p.y) - ry;
    alpha = cover(hull);

    // Cockpit, offset slightly aft.
    float cockpit = length(vec2((p.x + 0.10) / 0.34, p.y / 0.17)) - 1.0;
    col.rgb = mix(col.rgb, col.rgb * 0.34, cover(cockpit));

    // Bow highlight so heading is readable at a glance.
    float bow = length(vec2((p.x - 0.72) / 0.20, p.y / 0.13)) - 1.0;
    col.rgb = mix(col.rgb, vec3(0.98, 0.94, 0.80), cover(bow) * 0.85);

    // Paddle blades flash on the side that just took a stroke.
    // uParam packs left in the units digit and right in the tenths.
    float flashL = floor(uParam) / 100.0;
    float flashR = fract(uParam);
    float blade = 0.0;
    if (flashL > 0.005) {
      float b = length(vec2(p.x / 0.30, (p.y + 0.95) / 0.16)) - 1.0;
      blade = max(blade, cover(b) * flashL * 8.0);
    }
    if (flashR > 0.005) {
      float b = length(vec2(p.x / 0.30, (p.y - 0.95) / 0.16)) - 1.0;
      blade = max(blade, cover(b) * flashR * 8.0);
    }
    blade = clamp(blade, 0.0, 1.0);
    if (blade > 0.0) {
      col.rgb = mix(col.rgb, vec3(0.99, 0.86, 0.35), blade);
      alpha = max(alpha, blade);
    }
  } else if (uShape == 1) {
    // Goal: a pulsing target ring.
    float r = length(p);
    float pulse = 0.06 * sin(uTime * 2.6);
    float outer = abs(r - (0.86 + pulse)) - 0.10;
    float inner = abs(r - (0.44 + pulse * 0.5)) - 0.07;
    alpha = max(cover(outer), cover(inner) * 0.8);
    alpha = max(alpha, cover(r - 0.13));
  } else if (uShape == 2) {
    // Rock: a lumpy blob so obstacles don't read as billiard balls.
    float a = atan(p.y, p.x);
    float wobble = 1.0 - 0.13 * sin(a * 3.0 + 0.7) - 0.08 * sin(a * 5.0 + 2.1);
    float d = length(p) - wobble;
    alpha = cover(d);
    // Lit from the same direction as the terrain.
    float shade = 0.62 + 0.45 * dot(normalize(p + vec2(0.001)), normalize(vec2(-0.55, -0.72)));
    col.rgb *= clamp(shade, 0.45, 1.35);
    // A pale dry crown, as if standing proud of the water.
    col.rgb = mix(col.rgb, col.rgb * 1.35, cover(length(p + vec2(0.12, 0.16)) - 0.42) * 0.6);
  } else if (uShape == 3) {
    // Source: concentric rings washing outward from a spring.
    float r = length(p);
    float rings = fract(r * 2.4 - uTime * 0.85);
    float band = smoothstep(0.55, 0.95, rings) * smoothstep(0.0, 0.25, 1.0 - r);
    alpha = max(cover(r - 0.26), band * 0.75);
  } else if (uShape == 4) {
    // Ring: a plain outline, used for the brush cursor and selection.
    float r = length(p);
    alpha = cover(abs(r - 0.92) - uParam);
  } else {
    // Start: a circle with a chevron pointing along the launch heading.
    float r = length(p);
    alpha = cover(abs(r - 0.84) - 0.09);
    vec2 q = p - vec2(0.12, 0.0);
    float tri = max(abs(q.y) * 1.5 + q.x - 0.42, -q.x - 0.18);
    alpha = max(alpha, cover(tri));
  }

  if (alpha <= 0.001) discard;
  fragColor = vec4(col.rgb, col.a * alpha);
}`;

export interface SpriteOptions {
  shape: ShapeId;
  x: number;
  y: number;
  /** Half-extent in world metres. */
  size: number;
  rotation?: number;
  colour: [number, number, number, number];
  param?: number;
  /** Stretch along the local x axis, for the kayak's length. */
  aspect?: number;
}

export class SpritePass {
  private program: WebGLProgram;
  private uniforms: Uniforms;
  private vao: WebGLVertexArrayObject;

  constructor(private gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, VERTEX_SOURCE, FRAGMENT_SOURCE);
    this.uniforms = new Uniforms(gl, this.program);

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Could not create VAO');
    const buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // Triangle strip covering the unit square, with room for the paddle flash.
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1.3, -1.3, 1.3, -1.3, -1.3, 1.3, 1.3, 1.3]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.vao = vao;
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
  }

  begin(camera: Camera, time: number): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.uniforms.f2('uCamera', camera.x, camera.y);
    this.uniforms.f2(
      'uHalfExtent',
      camera.viewWidth / 2 / camera.zoom,
      camera.viewHeight / 2 / camera.zoom,
    );
    this.uniforms.f1('uTime', time);
  }

  draw(s: SpriteOptions): void {
    const u = this.uniforms;
    u.i1('uShape', s.shape);
    u.f2('uPos', s.x, s.y);
    u.f2('uSize', s.size * (s.aspect ?? 1), s.size);
    u.f1('uRot', s.rotation ?? 0);
    u.f4('uColour', s.colour[0], s.colour[1], s.colour[2], s.colour[3]);
    u.f1('uParam', s.param ?? 0.06);
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  end(): void {
    this.gl.disable(this.gl.BLEND);
    this.gl.bindVertexArray(null);
  }
}
