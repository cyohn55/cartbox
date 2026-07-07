/**
 * Single-pass WebGL1 post-process renderer shared by the editor's FX tab and
 * the runtime player. Takes one frame — either raw RGBA bytes at native cart
 * resolution or a source canvas — as a nearest-filtered texture and draws it
 * through one fragment shader implementing the whole effect chain; per-effect
 * intensity arrives as uniforms (neutral when disabled), so the pipeline
 * compiles once. WebGL1 is used (not WebGPU) because this is a one-texture
 * full-screen quad — maximum compatibility, no async device setup.
 *
 * Effect order mirrors a physical signal path: sample through CRT curvature
 * and chromatic aberration, add bloom, then grade → posterize → fog →
 * vignette → scanlines on the composed colour.
 */

import type { PostFxUniforms } from "./postfx.js";

/** A frame to post-process: raw RGBA bytes or a canvas to sample. */
export type PostFxSource = Uint8Array | Uint8ClampedArray | TexImageSource;

const VERTEX_SOURCE = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  // Screen-space UV with a top-left origin, so uv.y matches image row order.
  vUv = vec2((aPosition.x + 1.0) * 0.5, (1.0 - aPosition.y) * 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_SOURCE = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSource;
uniform vec2 uSourceSize;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uFogDensity;
uniform float uFogHorizon;
uniform vec3 uFogColor;
uniform float uBloomStrength;
uniform float uBloomThreshold;
uniform float uCurvature;
uniform float uScanlines;
uniform float uAberration;
uniform float uVignette;
uniform float uPosterize;

float luma(vec3 color) {
  return dot(color, vec3(0.299, 0.587, 0.114));
}

vec3 brightPass(vec2 uv) {
  vec3 color = texture2D(uSource, uv).rgb;
  return color * smoothstep(uBloomThreshold, 1.0, luma(color));
}

void main() {
  // CRT barrel curvature: bow the sampling grid outward from the centre.
  vec2 centered = vUv - 0.5;
  vec2 uv = vUv + centered * dot(centered, centered) * uCurvature * 4.0;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Chromatic aberration: R and B sampled slightly toward/away from centre.
  vec2 fringe = centered * uAberration / uSourceSize;
  vec3 color = vec3(
    texture2D(uSource, uv + fringe).r,
    texture2D(uSource, uv).g,
    texture2D(uSource, uv - fringe).b
  );

  // Bloom: 3x3 bright-pass blur added on top (cheap at cart resolution).
  if (uBloomStrength > 0.0) {
    vec2 texel = 1.0 / uSourceSize;
    vec3 glow = vec3(0.0);
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        float weight = (dx == 0 && dy == 0) ? 0.25 : (dx == 0 || dy == 0) ? 0.125 : 0.0625;
        glow += brightPass(uv + vec2(float(dx), float(dy)) * texel) * weight;
      }
    }
    color += glow * uBloomStrength;
  }

  // Grade: brightness, then contrast around mid-grey, then saturation.
  color *= uBrightness;
  color = (color - 0.5) * uContrast + 0.5;
  color = mix(vec3(luma(color)), color, uSaturation);

  // Posterize: quantise each channel to uPosterize levels (0 = off).
  if (uPosterize >= 2.0) {
    color = floor(color * uPosterize) / (uPosterize - 1.0);
    color = min(color, vec3(1.0));
  }

  // Fog: thickens from the horizon line upward (distance in a 2D scene).
  // smoothstep needs edge0 < edge1, so invert the ramp instead of the edges.
  float fogAmount = uFogDensity * (1.0 - smoothstep(uFogHorizon - 0.35, uFogHorizon + 0.35, uv.y));
  color = mix(color, uFogColor, clamp(fogAmount, 0.0, 1.0));

  // Vignette: radial darkening toward the corners.
  float falloff = 1.0 - uVignette * smoothstep(0.25, 0.75, dot(centered, centered) * 2.0);
  color *= falloff;

  // Scanlines: darken alternate source rows (identity when strength is 0).
  float scan = 1.0 - uScanlines * 0.25 * (1.0 + sin(uv.y * uSourceSize.y * 3.14159));
  color *= scan;

  gl_FragColor = vec4(color, 1.0);
}
`;

export class PostFxPass {
  private readonly uniformLocations = new Map<string, WebGLUniformLocation | null>();

  private constructor(
    private readonly gl: WebGLRenderingContext,
    private readonly program: WebGLProgram,
    private readonly texture: WebGLTexture,
  ) {}

  /** Returns null when WebGL is unavailable or the shaders fail to compile. */
  static create(canvas: HTMLCanvasElement): PostFxPass | null {
    const gl = canvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: true });
    if (!gl) return null;

    const compile = (type: number, source: string): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("PostFx shader compile failed:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("PostFx program link failed:", gl.getProgramInfoLog(program));
      return null;
    }
    gl.useProgram(program);

    // Fullscreen quad as a two-triangle strip.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const positionLocation = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return new PostFxPass(gl, program, texture);
  }

  private location(name: string): WebGLUniformLocation | null {
    if (!this.uniformLocations.has(name)) {
      this.uniformLocations.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.uniformLocations.get(name) ?? null;
  }

  /** Upload one frame and draw it through the effect chain. */
  render(source: PostFxSource, width: number, height: number, uniforms: PostFxUniforms): void {
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (source instanceof Uint8Array || source instanceof Uint8ClampedArray) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
      );
    } else {
      // Canvas/image sources upload GPU-side (no CPU readback of the frame).
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }

    gl.uniform1i(this.location("uSource"), 0);
    gl.uniform2f(this.location("uSourceSize"), width, height);
    gl.uniform1f(this.location("uBrightness"), uniforms.brightness);
    gl.uniform1f(this.location("uContrast"), uniforms.contrast);
    gl.uniform1f(this.location("uSaturation"), uniforms.saturation);
    gl.uniform1f(this.location("uFogDensity"), uniforms.fogDensity);
    gl.uniform1f(this.location("uFogHorizon"), uniforms.fogHorizon);
    gl.uniform3f(this.location("uFogColor"), ...uniforms.fogColor);
    gl.uniform1f(this.location("uBloomStrength"), uniforms.bloomStrength);
    gl.uniform1f(this.location("uBloomThreshold"), uniforms.bloomThreshold);
    gl.uniform1f(this.location("uCurvature"), uniforms.curvature);
    gl.uniform1f(this.location("uScanlines"), uniforms.scanlines);
    gl.uniform1f(this.location("uAberration"), uniforms.aberration);
    gl.uniform1f(this.location("uVignette"), uniforms.vignette);
    gl.uniform1f(this.location("uPosterize"), uniforms.posterize);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteProgram(this.program);
  }
}
