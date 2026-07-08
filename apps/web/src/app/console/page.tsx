/**
 * /console — the handheld experience. A fixed overlay covers the whole
 * viewport (site chrome included), so this route feels like powering on a
 * device: shell + boot loader → title → sign-in → console homescreen.
 *
 * Phones land here automatically from "/"; on desktop the wide viewport gets
 * the landscape (AYN Thor) layout, which doubles as the preview.
 */

import { HandheldConsole } from "./HandheldConsole";
import { ConsoleOS } from "./ConsoleOsApp";

export const metadata = {
  title: "Cartbox Console",
  description: "Boot the Cartbox handheld: play, browse, and share tiny games.",
};

export default function ConsolePage() {
  return (
    <HandheldConsole>
      <ConsoleOS />
    </HandheldConsole>
  );
}
