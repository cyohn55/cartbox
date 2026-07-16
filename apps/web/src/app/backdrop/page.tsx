import { BackdropManager } from "./BackdropManager";

/**
 * The backdrop prop manager route (`/backdrop`): edit the onboarding scene's 3D
 * objects — arrange, tune motion, add/remove, and hand a prop to the sprite
 * editor to redraw. Client-rendered (localStorage working copy), so it exports
 * cleanly to the static site.
 */
export default function BackdropPage() {
  return <BackdropManager />;
}
