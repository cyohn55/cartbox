import { Suspense } from "react";

import { HandheldPicker } from "./HandheldPicker";

/**
 * Handheld selection step of onboarding. After verifying their email a new user
 * lands here to choose or customize their handheld before reaching their
 * profile. `HandheldPicker` reads `?next` via useSearchParams, so it renders
 * inside a Suspense boundary.
 */
export default function HandheldOnboardingPage() {
  return (
    <Suspense fallback={null}>
      <HandheldPicker />
    </Suspense>
  );
}
