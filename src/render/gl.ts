/** Minimal WebGL2 helpers. No engine, just the boilerplate worth naming. */

export function createContext(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  return gl;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Could not create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('Could not create program');

  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed: ${log}`);
  }
  return program;
}

/** Cache of uniform locations so hot paths don't call getUniformLocation. */
export class Uniforms {
  private locations = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private gl: WebGL2RenderingContext,
    private program: WebGLProgram,
  ) {}

  loc(name: string): WebGLUniformLocation | null {
    let l = this.locations.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.program, name);
      this.locations.set(name, l);
    }
    return l;
  }

  f1(name: string, v: number): void {
    this.gl.uniform1f(this.loc(name), v);
  }
  i1(name: string, v: number): void {
    this.gl.uniform1i(this.loc(name), v);
  }
  f2(name: string, x: number, y: number): void {
    this.gl.uniform2f(this.loc(name), x, y);
  }
  f3(name: string, x: number, y: number, z: number): void {
    this.gl.uniform3f(this.loc(name), x, y, z);
  }
  f4(name: string, x: number, y: number, z: number, w: number): void {
    this.gl.uniform4f(this.loc(name), x, y, z, w);
  }
}

/**
 * A single triangle covering the viewport. One triangle rather than two so
 * there's no diagonal seam and one less vertex to transform.
 */
export function createFullscreenTriangle(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('Could not create VAO');
  const buffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

export interface FloatTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
  /** Channels per texel: 1 for terrain, 4 for the water field. */
  channels: number;
}

/**
 * Create a half-float texture that can be sampled with linear filtering.
 *
 * WebGL2 guarantees 16-bit float textures are filterable, while 32-bit ones
 * need OES_texture_float_linear that not every mobile GPU exposes. Data is
 * still uploaded as plain Float32Array - the driver does the conversion - so
 * nothing on the CPU side has to deal with half floats.
 */
export function createFloatTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  channels: 1 | 4,
): FloatTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Could not create texture');

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, channels === 1 ? gl.R16F : gl.RGBA16F, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return { texture, width, height, channels };
}

export function uploadFloatTexture(
  gl: WebGL2RenderingContext,
  tex: FloatTexture,
  data: Float32Array,
): void {
  gl.bindTexture(gl.TEXTURE_2D, tex.texture);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    tex.width,
    tex.height,
    tex.channels === 1 ? gl.RED : gl.RGBA,
    gl.FLOAT,
    data,
  );
}

/** Upload only the rectangle a brush stroke touched. */
export function uploadFloatTextureRegion(
  gl: WebGL2RenderingContext,
  tex: FloatTexture,
  source: Float32Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  scratch: Float32Array,
): void {
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const needed = w * h * tex.channels;
  const patch = scratch.length >= needed ? scratch.subarray(0, needed) : new Float32Array(needed);

  for (let y = 0; y < h; y++) {
    const src = (y0 + y) * tex.width + x0;
    patch.set(source.subarray(src, src + w), y * w);
  }

  gl.bindTexture(gl.TEXTURE_2D, tex.texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    x0,
    y0,
    w,
    h,
    tex.channels === 1 ? gl.RED : gl.RGBA,
    gl.FLOAT,
    patch,
  );
}
