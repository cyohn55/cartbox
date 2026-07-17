import { Suspense } from "react";

import { HandheldPicker } from "./HandheldPicker";
import { LitBackdrop } from "./LitBackdrop";
import { ChassisColorProvider } from "./chassisColor";

/**
 * Handheld selection step of onboarding. After verifying their email a new user
 * lands here to choose or customize their handheld before reaching their
 * profile. `HandheldPicker` reads `?next` via useSearchParams, so it renders
 * inside a Suspense boundary. `LitBackdrop` is the lit pixel-art wall behind it.
 */
export default function HandheldOnboardingPage() {
  return (
    <ChassisColorProvider>
      <LitBackdrop />
      <Suspense fallback={null}>
        <HandheldPicker />
      </Suspense>
    </ChassisColorProvider>
  );
}
