/**
 * Gyro aim on a phone or tablet (CONTROLLER_SETTINGS_ROADMAP.md C4b): the
 * device's rotation rate from the DeviceMotion API, read each tick and turned
 * into look by gyroLean. iOS only sends motion after the page asks for it
 * from a tap (DeviceMotionEvent.requestPermission, see {@link askMotionPermission}).
 */

/** How old (ms) a reading may be before the device counts as still: motion events stop when it is. */
const STALE_MS = 120;

interface RotationRate {
  readonly alpha: number | null;
  readonly beta: number | null;
  readonly gamma: number | null;
}

export class GyroLook {
  private rate: RotationRate | null = null;
  private at = 0;
  private readonly onMotion = (event: DeviceMotionEvent) => {
    if (!event.rotationRate) return;
    this.rate = event.rotationRate;
    this.at = this.view.performance.now();
  };

  constructor(private readonly view: Window) {
    view.addEventListener("devicemotion", this.onMotion);
  }

  /** The latest rotation rate (degrees a second), or null when there's none fresh. */
  latest(): RotationRate | null {
    return this.rate && this.view.performance.now() - this.at < STALE_MS ? this.rate : null;
  }

  destroy(): void {
    this.view.removeEventListener("devicemotion", this.onMotion);
  }
}

/**
 * Ask for motion where the browser needs it (iOS 13+), from a tap: true when
 * gyro aim can read motion, false when the player said no.
 */
export async function askMotionPermission(view: Window = window): Promise<boolean> {
  const motion = (view as Window & { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
  if (!motion?.requestPermission) return true;
  try {
    return (await motion.requestPermission()) === "granted";
  } catch {
    return false;
  }
}
