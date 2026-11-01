/**
 * A face at runtime (AAA_FIDELITY_ROADMAP.md F7b; faces.ts in @cartbox/editor):
 * the weights an object's morph targets take each frame, from what it says
 * (a viseme track, from phonemes or audio), where it looks (saccades and
 * blinks), an expression and a recorded face clip, layered in ARKit's terms
 * and handed to the mesh's targets through its rig.
 */

import {
  ARKIT_SHAPES,
  Gaze,
  faceRig,
  faceWeights,
  gazeWeights,
  layerFace,
  lipSyncWeights,
  sampleFace,
  type FaceClip,
  type FaceRig,
  type MeshAsset,
  type VisemeSpan,
} from "@cartbox/editor";

const AHEAD: readonly number[] = [0, 0, 1];

export class FaceDriver {
  readonly rig: FaceRig;
  private readonly gaze: Gaze;
  private time = 0;
  private speech: { readonly track: readonly VisemeSpan[]; readonly start: number } | null = null;
  private looking: readonly number[] | null = null;
  private expression: Float32Array | null = null;
  private clip: { readonly clip: FaceClip; readonly start: number; readonly loop: boolean } | null = null;
  private readonly mouth = new Float32Array(ARKIT_SHAPES.length);
  private readonly recorded = new Float32Array(ARKIT_SHAPES.length);

  constructor(private readonly mesh: MeshAsset, seed = 1) {
    this.rig = faceRig(mesh);
    this.gaze = new Gaze(seed);
  }

  /** Say a viseme track, starting `delay` seconds from now. */
  speak(track: readonly VisemeSpan[], delay = 0): void {
    this.speech = { track, start: this.time + delay };
  }

  /** Look along a direction in the head's space (+z ahead, +y up, +x its left), or ahead with null. */
  lookAt(direction: readonly number[] | null): void {
    this.looking = direction;
  }

  /** Hold an expression (52 ARKit weights), or none. */
  setExpression(weights: ArrayLike<number> | null): void {
    this.expression = weights ? Float32Array.from({ length: ARKIT_SHAPES.length }, (_, i) => weights[i] ?? 0) : null;
  }

  /** Play a recorded face clip (Live Link Face, say) from now, or stop one. */
  play(clip: FaceClip | null, loop = false): void {
    this.clip = clip ? { clip, start: this.time, loop } : null;
  }

  /** Advance `dt` seconds: the mesh's morph weights now (its own weights for targets ARKit doesn't name). */
  update(dt: number): Float32Array {
    this.time += Math.max(0, dt);
    const layers: ArrayLike<number>[] = [];
    if (this.expression) layers.push(this.expression);
    if (this.clip) {
      const { clip, start, loop } = this.clip;
      let t = this.time - start;
      if (loop && clip.duration > 0) t %= clip.duration;
      layers.push(sampleFace(clip, t, this.recorded));
    }
    if (this.speech) {
      const t = this.time - this.speech.start;
      layers.push(lipSyncWeights(this.speech.track, t, this.mouth));
      const end = this.speech.track.reduce((m, s) => Math.max(m, s.end), 0);
      if (t > end + 1) this.speech = null;
    }
    layers.push(gazeWeights(this.gaze.update(dt, this.looking ?? AHEAD)));
    return faceWeights(this.rig, layerFace(...layers), this.mesh.morphWeights ?? []);
  }
}
