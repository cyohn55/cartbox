/**
 * Avatar drawing. Renders an {@link AvatarSpec} as layered placeholder shapes
 * onto a 2D canvas context. Shared by the editor (live preview) and the
 * read-only profile preview. Real sprite sheets keyed by the same part indices
 * can replace this drawing without touching the data model.
 */

import type { AvatarSpec } from "./avatar";

export const PREVIEW_SIZE = 128;

export function drawAvatar(ctx: CanvasRenderingContext2D, spec: AvatarSpec): void {
  const [c0, c1, c2, c3] = spec.palette;
  ctx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);

  // Body — shape depends on parts.body.
  ctx.fillStyle = c0!;
  ctx.beginPath();
  const bodyShape = spec.parts.body;
  if (bodyShape === 0) ctx.arc(64, 68, 46, 0, Math.PI * 2);
  else if (bodyShape === 1) ctx.rect(22, 26, 84, 84);
  else if (bodyShape === 2) ctx.roundRect(24, 26, 80, 84, 22);
  else {
    ctx.moveTo(64, 20);
    ctx.lineTo(108, 68);
    ctx.lineTo(64, 116);
    ctx.lineTo(20, 68);
    ctx.closePath();
  }
  ctx.fill();

  // Face — a lighter oval; size varies with parts.face.
  ctx.fillStyle = c2!;
  ctx.beginPath();
  ctx.ellipse(64, 66, 28 + spec.parts.face * 2, 30 + spec.parts.face, 0, 0, Math.PI * 2);
  ctx.fill();

  // Hair — a cap on top; style varies with parts.hair.
  ctx.fillStyle = c1!;
  ctx.beginPath();
  const hair = spec.parts.hair;
  ctx.arc(64, 52, 30, Math.PI, Math.PI * 2);
  if (hair % 2 === 1) ctx.rect(34, 40, 60, 12);
  ctx.fill();

  // Eyes — two marks; spacing/size vary with parts.eyes.
  ctx.fillStyle = c3!;
  const eyeGap = 10 + spec.parts.eyes * 2;
  const eyeR = 3 + (spec.parts.eyes % 3);
  for (const dx of [-eyeGap, eyeGap]) {
    ctx.beginPath();
    ctx.arc(64 + dx, 64, eyeR, 0, Math.PI * 2);
    ctx.fill();
  }

  // Accessory — parts.accessory 0 = none, else a colored bar (glasses/visor).
  if (spec.parts.accessory > 0) {
    ctx.strokeStyle = c1!;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(64 - eyeGap - 6, 64);
    ctx.lineTo(64 + eyeGap + 6, 64);
    ctx.stroke();
  }
}
