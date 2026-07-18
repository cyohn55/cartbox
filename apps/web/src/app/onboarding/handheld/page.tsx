import { Suspense } from "react";

import { HandheldPicker } from "./HandheldPicker";
import { VoxelWorldBackdrop } from "./VoxelWorldBackdrop";
import { ChassisColorProvider } from "./chassisColor";

/**
 * Handheld selection step of onboarding. After verifying their email a new user
 * lands here to choose or customize their handheld before reaching their
 * profile. `HandheldPicker` reads `?next` via useSearchParams, so it renders
 * inside a Suspense boundary. `VoxelWorldBackdrop` is the slowly rotating
 * Minecraft-style voxel world behind it, its sky tinted to the chosen chassis.
 */
export default function HandheldOnboardingPage() {
  return (
    <ChassisColorProvider>
      <VoxelWorldBackdrop />
      <Suspense fallback={null}>
        <HandheldPicker />
      </Suspense>
    </ChassisColorProvider>
  );
}
