"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function FilterPicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex shrink-0 items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-foreground/50">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          size="sm"
          aria-label={`${label} filter`}
          className="h-7 bg-muted/40 text-[12px]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value} className="text-[12px]">
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
