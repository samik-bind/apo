"use client";

// PROTOTYPE (see shared.tsx) — dispatcher. Renders the active variant plus a
// mono state readout underneath (the serialized filter state every page would
// write), so flipping variants also shows how each one represents state.

import { shortModel } from "@/lib/run-configuration";

import { PROTOTYPE_VARIANTS, type PrototypeFilterProps, type PrototypeVariant } from "./shared";
import { PrototypeSwitcher } from "./prototype-switcher";
import { VariantA } from "./variant-a";
import { VariantB } from "./variant-b";
import { VariantC } from "./variant-c";

export type { PrototypeFilterProps, PrototypeStatusOption, PrototypeVariant } from "./shared";

export function PrototypeFilterRow({
  variant,
  ...props
}: PrototypeFilterProps & { variant: string | null | undefined }) {
  const v = (PROTOTYPE_VARIANTS as readonly string[]).includes(variant ?? "")
    ? (variant as PrototypeVariant)
    : "A";

  return (
    <div className="flex flex-col gap-1.5">
      {v === "A" ? (
        <VariantA {...props} />
      ) : v === "B" ? (
        <VariantB {...props} />
      ) : (
        <VariantC {...props} />
      )}
      <div className="font-mono text-[10px] text-muted-foreground/50">
        prototype {v.toLowerCase()} · {readout(props)}
        {props.readoutNote ? ` · ${props.readoutNote}` : ""}
      </div>
      <PrototypeSwitcher />
    </div>
  );
}

function readout(p: PrototypeFilterProps): string {
  const parts: string[] = [];
  if (p.query) parts.push(`q="${p.query}"`);
  if (p.status.size > 0) {
    parts.push(
      p.status.size === p.statusOptions.length
        ? "status=all"
        : `status=${Array.from(p.status).join(",")}`,
    );
  }
  if (p.model) parts.push(`model=${shortModel(p.model)}`);
  if (p.effort) parts.push(`effort=${p.effort}`);
  if (p.since) parts.push(`since=${p.since}`);
  return parts.length > 0 ? parts.join(" · ") : "no filters";
}
