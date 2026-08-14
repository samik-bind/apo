import * as React from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  // Undefined until mounted so server and client render the same first
  // frame; reading window.innerWidth during initialization would branch the
  // hydration render on a browser global.
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}
