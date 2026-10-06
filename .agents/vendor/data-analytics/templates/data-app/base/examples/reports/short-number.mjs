const UNITS = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "k"],
];

const format = (value) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);

export function shortNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  const absolute = Math.abs(numeric);
  let unitIndex = UNITS.findIndex(([threshold]) => absolute >= threshold);
  if (unitIndex < 0) return format(numeric);

  while (unitIndex > 0) {
    const [threshold] = UNITS[unitIndex];
    if (Math.abs(Number((numeric / threshold).toFixed(1))) < 1000) break;
    unitIndex -= 1;
  }

  const [threshold, suffix] = UNITS[unitIndex];
  return `${format(Number((numeric / threshold).toFixed(1)))}${suffix}`;
}
