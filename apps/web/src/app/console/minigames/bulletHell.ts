/**
 * Bullet Hell — dodge spiraling bullet patterns as long as you can. The
 * D-pad moves; survival time is the score. Attract mode drifts away from the
 * densest nearby cluster.
 */

import type { CanvasMiniGame, MiniGameInput, MiniGameSession } from "./types";

interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

class BulletHellSession implements MiniGameSession {
  private player: { x: number; y: number };
  private bullets: Bullet[] = [];
  private frame = 0;
  private survived = 0;
  private best = 0;
  private deadFrames = 0;
  private spiral = 0;

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {
    this.player = { x: width / 2, y: height * 0.7 };
  }

  step(input: MiniGameInput, attract: boolean): void {
    this.frame += 1;

    if (this.deadFrames > 0) {
      this.deadFrames += 1;
      if (this.deadFrames > 90) {
        this.bullets = [];
        this.survived = 0;
        this.deadFrames = 0;
        this.player = { x: this.width / 2, y: this.height * 0.7 };
      }
      return;
    }
    this.survived += 1;
    this.best = Math.max(this.best, this.survived);

    const drive = attract ? this.autopilot() : input;
    const speed = 2.2;
    if (drive.left) this.player.x -= speed;
    if (drive.right) this.player.x += speed;
    if (drive.up) this.player.y -= speed;
    if (drive.down) this.player.y += speed;
    this.player.x = Math.max(6, Math.min(this.width - 6, this.player.x));
    this.player.y = Math.max(6, Math.min(this.height - 6, this.player.y));

    // Emitters: a rotating spiral from the center-top plus edge sprays that
    // thicken over time.
    const difficulty = 1 + this.survived / 1800;
    if (this.frame % Math.max(3, Math.round(8 / difficulty)) === 0) {
      this.spiral += 0.55;
      const cx = this.width / 2;
      const cy = this.height * 0.25;
      this.bullets.push({
        x: cx,
        y: cy,
        vx: Math.cos(this.spiral) * 1.5 * difficulty,
        vy: Math.sin(this.spiral) * 1.5 * difficulty,
      });
    }
    if (this.frame % 45 === 0) {
      const fromLeft = Math.random() < 0.5;
      this.bullets.push({
        x: fromLeft ? 0 : this.width,
        y: Math.random() * this.height * 0.5,
        vx: (fromLeft ? 1 : -1) * (0.8 + Math.random()) * difficulty,
        vy: 0.4 + Math.random() * 0.8,
      });
    }

    this.bullets = this.bullets.filter((bullet) => {
      bullet.x += bullet.vx;
      bullet.y += bullet.vy;
      return bullet.x > -8 && bullet.x < this.width + 8 && bullet.y > -8 && bullet.y < this.height + 8;
    });

    if (this.bullets.some((bullet) => (bullet.x - this.player.x) ** 2 + (bullet.y - this.player.y) ** 2 < 36)) {
      this.deadFrames = 1;
    }
  }

  /** Attract mode: run from the nearest threatening bullet. */
  private autopilot(): MiniGameInput {
    let threatX = 0;
    let threatY = 0;
    for (const bullet of this.bullets) {
      const dx = this.player.x - bullet.x;
      const dy = this.player.y - bullet.y;
      const distance = dx * dx + dy * dy;
      if (distance < 60 ** 2 && distance > 0) {
        threatX += dx / distance;
        threatY += dy / distance;
      }
    }
    // Gentle pull back toward home keeps the demo on screen.
    threatX += (this.width / 2 - this.player.x) / 40000;
    threatY += (this.height * 0.7 - this.player.y) / 40000;
    return {
      up: threatY < -0.0006,
      down: threatY > 0.0006,
      left: threatX < -0.0006,
      right: threatX > 0.0006,
      a: false,
      b: false,
    };
  }

  draw(context: CanvasRenderingContext2D): void {
    context.fillStyle = "#ff5d8f";
    for (const bullet of this.bullets) {
      context.beginPath();
      context.arc(bullet.x, bullet.y, 3, 0, Math.PI * 2);
      context.fill();
    }

    if (this.deadFrames === 0) {
      context.fillStyle = "#57d18d";
      context.beginPath();
      context.arc(this.player.x, this.player.y, 4, 0, Math.PI * 2);
      context.fill();
    }

    context.fillStyle = "#9990bb";
    context.font = "700 10px monospace";
    context.fillText(`BULLET HELL ${(this.survived / 60).toFixed(1)}s · BEST ${(this.best / 60).toFixed(1)}s`, 8, 14);
  }
}

export const bulletHellMiniGame: CanvasMiniGame = {
  kind: "canvas",
  id: "bullet-hell",
  title: "Bullet Hell",
  addedIn: "2026-07",
  create: (width, height) => new BulletHellSession(width, height),
};
