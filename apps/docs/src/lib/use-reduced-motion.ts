import { useSyncExternalStore } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void) {
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/**
 * useReducedMotion — true when the user has asked for less motion.
 *
 * Replaces the `motion/react` `useReducedMotion` hook so the docs app avoids
 * pulling the full Framer Motion package for a single matchMedia listener.
 * See docs/design.md "Motion" — every animation freezes to a static frame here.
 *
 * useSyncExternalStore keeps the server and hydration frames identical (the
 * server snapshot is false) and re-renders when the preference flips — no
 * state initialized from a browser global inside an effect. Same pattern as
 * the dashboard's hooks/use-mobile.tsx.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}
