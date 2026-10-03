import { object, type ArmRecord } from "../../daemon/shadow/types.js";

export function milliseconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
/** Model duration is outside the hook wait; overhead excludes native's own duration. */
export function hookAddedLatency(arms: readonly ArmRecord[]): number | null {
  const values = new Set(arms.flatMap(arm => {
    const timing = arm.timings;
    if (!object(timing) || !(["setupMs", "nativeMs", "pairingMs", "hookMs"] as const).every(key => milliseconds(timing[key]) !== null)) return [];
    return timing.hookMs >= timing.nativeMs ? [timing.hookMs - timing.nativeMs] : [];
  }));
  return values.size === 1 ? [...values][0] : null;
}
export function summarizeHookLatency(values: readonly (number | null)[]) {
  const known = values.filter(value => value !== null).sort((left, right) => left - right);
  const percentile = (fraction: number) => known.length ? known[Math.ceil(fraction * known.length) - 1] : null;
  return { recordedCuts: known.length, unknownCuts: values.length - known.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}
