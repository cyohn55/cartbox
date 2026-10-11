/**
 * Mouse look on a computer (CONTROLLER_SETTINGS_ROADMAP.md C4). With the
 * player's "mouse look" on, a click on the game captures the pointer (the
 * Pointer Lock API); while captured, the mouse's movement each tick becomes
 * look-stick lean (see mouseLean) and its buttons become keys an input action
 * can bind: "Mouse0" (left), "Mouse1" (middle), "Mouse2" (right). Esc releases
 * it, as the browser always does.
 */

const NO_KEYS: ReadonlySet<string> = new Set();

export class MouseLook {
  private dx = 0;
  private dy = 0;
  private readonly buttons = new Set<string>();
  private readonly doc: Document;

  private readonly onDown = (event: MouseEvent) => {
    if (!this.enabled()) return;
    if (!this.captured) {
      if (event.button !== 0) return;
      // A click captures the mouse (it needs this gesture); it doesn't also fire.
      try {
        const request = this.container.requestPointerLock?.() as unknown;
        if (request instanceof Promise) request.catch(() => undefined);
      } catch {
        // No pointer lock here (an iframe without the permission, say): the mouse stays a pointer.
      }
      return;
    }
    event.preventDefault();
    this.buttons.add(`Mouse${event.button}`);
  };
  private readonly onUp = (event: MouseEvent) => {
    this.buttons.delete(`Mouse${event.button}`);
  };
  private readonly onMove = (event: MouseEvent) => {
    if (!this.captured) return;
    this.dx += event.movementX || 0;
    this.dy += event.movementY || 0;
  };
  private readonly onLockChange = () => {
    if (!this.captured) {
      this.buttons.clear();
      this.dx = 0;
      this.dy = 0;
    }
  };
  private readonly onContextMenu = (event: Event) => {
    if (this.captured) event.preventDefault();
  };

  constructor(
    private readonly container: HTMLElement,
    /** Whether the player has mouse look on (read at each click). */
    private readonly enabled: () => boolean,
  ) {
    this.doc = container.ownerDocument;
    container.addEventListener("mousedown", this.onDown, true);
    this.doc.addEventListener("mouseup", this.onUp, true);
    this.doc.addEventListener("mousemove", this.onMove, true);
    this.doc.addEventListener("pointerlockchange", this.onLockChange);
    container.addEventListener("contextmenu", this.onContextMenu);
  }

  /** Whether the mouse is captured by this game. */
  get captured(): boolean {
    return this.doc.pointerLockElement === this.container;
  }

  /** The mouse buttons held while captured, as keys ("Mouse0" …) for input actions. */
  get held(): ReadonlySet<string> {
    return this.buttons.size > 0 ? this.buttons : NO_KEYS;
  }

  /** The movement since the last tick (px), cleared. */
  take(): [number, number] {
    const out: [number, number] = [this.dx, this.dy];
    this.dx = 0;
    this.dy = 0;
    return out;
  }

  /** Let the mouse go (under a menu, or when mouse look is turned off). */
  release(): void {
    if (this.captured) this.doc.exitPointerLock?.();
    this.onLockChange();
  }

  destroy(): void {
    this.release();
    this.container.removeEventListener("mousedown", this.onDown, true);
    this.doc.removeEventListener("mouseup", this.onUp, true);
    this.doc.removeEventListener("mousemove", this.onMove, true);
    this.doc.removeEventListener("pointerlockchange", this.onLockChange);
    this.container.removeEventListener("contextmenu", this.onContextMenu);
  }
}
