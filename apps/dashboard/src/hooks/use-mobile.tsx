import * as React from "react";

const MOBILE_BREAKPOINT = 768;
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribeToBreakpoint(onChange: () => void) {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function useIsMobile() {
  // useSyncExternalStore keeps the server and hydration frames identical
  // (getServerSnapshot returns false) and re-renders on breakpoint change —
  // no useState/effect pair reading window.innerWidth.
  return React.useSyncExternalStore(
    subscribeToBreakpoint,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}
