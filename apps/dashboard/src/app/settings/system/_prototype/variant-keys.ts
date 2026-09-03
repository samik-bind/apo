// PROTOTYPE — variant registry for the System settings IA prototype
// (see ./NOTES.md). Plain module on purpose: the server page needs to read
// PROTOTYPE_VARIANTS, and values exported from "use client" modules arrive
// as client-reference stubs on the server.

export const PROTOTYPE_VARIANTS = [
  { key: "current", label: "Current — stacked cards" },
  { key: "a", label: "A — status hero + tabs" },
  { key: "b", label: "B — two-column console" },
  { key: "c", label: "C — config document" },
] as const;

export type PrototypeVariantKey = (typeof PROTOTYPE_VARIANTS)[number]["key"];

export function isPrototypeVariant(value: string): value is PrototypeVariantKey {
  return PROTOTYPE_VARIANTS.some((entry) => entry.key === value);
}
