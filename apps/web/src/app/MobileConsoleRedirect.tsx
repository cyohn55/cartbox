"use client";

/**
 * Sends handheld-sized touch devices from the marketing homepage straight into
 * the console experience, so a phone "boots" into the handheld on page load.
 * Desktop (fine pointer or large screen) keeps the regular site.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Longest screen edge below this (in CSS px) reads as a handheld device. */
const HANDHELD_MAX_EDGE_PX = 1024;

export function isHandheldViewport(
  coarsePointer: boolean,
  screenWidth: number,
  screenHeight: number,
): boolean {
  return coarsePointer && Math.min(screenWidth, screenHeight) < HANDHELD_MAX_EDGE_PX;
}

export function MobileConsoleRedirect() {
  const router = useRouter();

  useEffect(() => {
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    if (isHandheldViewport(coarse, window.screen.width, window.screen.height)) {
      router.replace("/console");
    }
  }, [router]);

  return null;
}
