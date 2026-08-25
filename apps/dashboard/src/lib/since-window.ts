/**
 * Date-window presets, shared by the Tasks evidence views and the Runs list.
 *
 * Both surfaces mean the same thing by a window — runs newer than a cutoff —
 * and the value travels between them when you navigate (see `run-cohort`), so
 * they speak one vocabulary. They used to keep separate lists: Tasks offered
 * `5h`/`2d`/`5d`/`14d`, Runs understood only `1h`/`24h`/`7d`/`30d`, and
 * anything outside its table read as all-time.
 *
 * The backend parses any `Nh`/`Nd` string, so a value outside this list (an
 * old `24h` bookmark, a hand-edited URL) is still valid: `sinceLabel` names it
 * and `sinceOptionsFor` keeps it selectable rather than blanking the control.
 */

/** Picker sentinel for "no window". The URL omits the param instead. */
export const ALL_SINCE_VALUE = "__all__";

export interface SinceOption {
  value: string;
  label: string;
}

export const SINCE_PRESETS: SinceOption[] = [
  { value: "1h", label: "1 hour" },
  { value: "5h", label: "5 hours" },
  { value: "1d", label: "1 day" },
  { value: "2d", label: "2 days" },
  { value: "3d", label: "3 days" },
  { value: "5d", label: "5 days" },
  { value: "7d", label: "7 days" },
  { value: "14d", label: "14 days" },
  { value: "30d", label: "30 days" },
];

/** Human label for a window, deriving one for values outside the presets. */
export function sinceLabel(value: string): string {
  const preset = SINCE_PRESETS.find((p) => p.value === value);
  if (preset) return preset.label;
  const match = /^(\d+)([hd])$/.exec(value);
  if (!match) return value;
  const amount = Number(match[1]);
  const unit = match[2] === "h" ? "hour" : "day";
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

/**
 * Options for a window picker: "All time", the presets, and `current` when it
 * is something else — so a carried-over or bookmarked window still shows.
 */
export function sinceOptionsFor(current: string | null): SinceOption[] {
  const options: SinceOption[] = [
    { value: ALL_SINCE_VALUE, label: "All time" },
    ...SINCE_PRESETS,
  ];
  if (current && !options.some((o) => o.value === current)) {
    options.push({ value: current, label: sinceLabel(current) });
  }
  return options;
}
