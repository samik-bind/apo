// Barrel re-export — keeps the `@/components/ui/collapsible` import path
// stable while each component lives in its own file (no-multi-comp).
export { Collapsible } from "./collapsible-root";
export { CollapsibleTrigger } from "./collapsible-trigger";
export { CollapsibleContent } from "./collapsible-content";
