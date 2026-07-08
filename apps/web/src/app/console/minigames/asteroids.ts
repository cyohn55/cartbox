/**
 * Asteroids — rotate/thrust/shoot with screen wrap. Left/right steer, up
 * thrusts, A fires. Attract mode hunts the nearest rock by itself.
 */

import type { CanvasMiniGame, MiniGameInput, MiniGameSession } from "./types";

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Rock extends Body {
  radius: number;
}

interface Bullet extends Body {
  life: number;
}

function wrap(body: Body, width: number, height: number): void {
  body.x = (body.x + width) % width;
  body.y = (body.y + height) % height;
}

class AsteroidsSession implements MiniGameSession {
  private ship: Body & { angle: number };
  private rocks: Rock[] = [];
  private bullets: Bullet[] = [];
  private score = 0;
  private cooldown = 0;
  private deadFrames = 0;

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {
    this.ship = { x: width / 2, y: height / 2, vx: 0, vy: 0, angle: -Math.PI / 2 };
    this.spawnRocks(4);
  }

  private spawnRocks(count: number): void {
    for (let i = 0; i < count; i += 1) {
      const edge = Math.random() < 0.5;
      this.rocks.push({
        x: edge ? 0 : Math.random() * this.width,
        y: edge ? Math.random() * this.height : 0,
        vx: (Math.random() - 0.5) * 1.6,
        vy: (Math.random() - 0.5) * 1.6,
        radius: 14 + Math.random() * 10,
      });
    }
  }

  step(input: MiniGameInput, attract: boolean): void {
    if (this.deadFrames > 0) {
      this.deadFrames += 1;
      if (this.deadFrames > 90) {
        this.rocks = [];
        this.bullets = [];
        this.score = 0;
        this.ship = { x: this.width / 2, y: this.height / 2, vx: 0, vy: 0, angle: -Math.PI / 2 };
        this.spawnRocks(4);
        this.deadFrames = 0;
      }
      return;
    }

    const drive = attract ? this.autopilot() : input;

    if (drive.left) this.ship.angle -= 0.08;
    if (drive.right) this.ship.angle += 0.08;
    if (drive.up) {
      this.ship.vx += Math.cos(this.ship.angle) * 0.08;
      this.ship.vy += Math.sin(this.ship.angle) * 0.08;
    }
    this.cooldown -= 1;
    if (drive.a && this.cooldown <= 0) {
      this.bullets.push({
        x: this.ship.x,
        y: this.ship.y,
        vx: Math.cos(this.ship.angle) * 4 + this.ship.vx,
        vy: Math.sin(this.ship.angle) * 4 + this.ship.vy,
        life: 70,
      });
      this.cooldown = 12;
    }

    this.ship.vx *= 0.99;
    this.ship.vy *= 0.99;
    this.ship.x += this.ship.vx;
    this.ship.y += this.ship.vy;
    wrap(this.ship, this.width, this.height);

    for (const rock of this.rocks) {
      rock.x += rock.vx;
      rock.y += rock.vy;
      wrap(rock, this.width, this.height);
    }
    this.bullets = this.bullets.filter((bullet) => {
      bullet.x += bullet.vx;
      bullet.y += bullet.vy;
      wrap(bullet, this.width, this.height);
      bullet.life -= 1;
      return bullet.life > 0;
    });

    // Bullet ↔ rock: split big rocks, score both.
    const spawned: Rock[] = [];
    this.rocks = this.rocks.filter((rock) => {
      const hitIndex = this.bullets.findIndex(
        (bullet) => (bullet.x - rock.x) ** 2 + (bullet.y - rock.y) ** 2 < rock.radius ** 2,
      );
      if (hitIndex < 0) {
        return true;
      }
      this.bullets.splice(hitIndex, 1);
      this.score += 10;
      if (rock.radius > 10) {
        for (let i = 0; i < 2; i += 1) {
          spawned.push({
            x: rock.x,
            y: rock.y,
            vx: (Math.random() - 0.5) * 2.4,
            vy: (Math.random() - 0.5) * 2.4,
            radius: rock.radius / 2,
          });
        }
      }
      return false;
    });
    this.rocks.push(...spawned);
    if (this.rocks.length === 0) {
      this.spawnRocks(5);
    }

    // Rock ↔ ship.
    if (
      this.rocks.some((rock) => (rock.x - this.ship.x) ** 2 + (rock.y - this.ship.y) ** 2 < (rock.radius + 5) ** 2)
    ) {
      this.deadFrames = 1;
    }
  }

  /** Attract mode: turn toward the nearest rock, keep distance, fire. */
  private autopilot(): MiniGameInput {
    let nearest: Rock | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const rock of this.rocks) {
      const distance = (rock.x - this.ship.x) ** 2 + (rock.y - this.ship.y) ** 2;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = rock;
      }
    }
    if (!nearest) {
      return { up: false, down: false, left: false, right: false, a: false, b: false };
    }
    const desired = Math.atan2(nearest.y - this.ship.y, nearest.x - this.ship.x);
    let delta = desired - this.ship.angle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return {
      up: nearestDistance > 120 ** 2 && Math.abs(delta) < 0.5,
      down: false,
      left: delta < -0.05,
      right: delta > 0.05,
      a: Math.abs(delta) < 0.2,
      b: false,
    };
  }

  draw(context: CanvasRenderingContext2D): void {
    context.strokeStyle = "#8f86c6";
    context.lineWidth = 1.5;
    for (const rock of this.rocks) {
      context.beginPath();
      context.arc(rock.x, rock.y, rock.radius, 0, Math.PI * 2);
      context.stroke();
    }

    context.fillStyle = "#f6b74a";
    for (const bullet of this.bullets) {
      context.fillRect(bullet.x - 1.5, bullet.y - 1.5, 3, 3);
    }

    if (this.deadFrames === 0) {
      const { x, y, angle } = this.ship;
      context.strokeStyle = "#57d18d";
      context.beginPath();
      context.moveTo(x + Math.cos(angle) * 10, y + Math.sin(angle) * 10);
      context.lineTo(x + Math.cos(angle + 2.5) * 8, y + Math.sin(angle + 2.5) * 8);
      context.lineTo(x + Math.cos(angle - 2.5) * 8, y + Math.sin(angle - 2.5) * 8);
      context.closePath();
      context.stroke();
    }

    context.fillStyle = "#9990bb";
    context.font = "700 10px monospace";
    context.fillText(`ASTEROIDS ${this.score}`, 8, 14);
  }
}

export const asteroidsMiniGame: CanvasMiniGame = {
  kind: "canvas",
  id: "asteroids",
  title: "Asteroids",
  addedIn: "2026-07",
  create: (width, height) => new AsteroidsSession(width, height),
};
