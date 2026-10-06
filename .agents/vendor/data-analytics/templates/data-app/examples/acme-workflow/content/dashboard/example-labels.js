// Example-owned vocabulary only. Field IDs and the shared Chart API stay unchanged.
export function exampleLabels(value, labels) {
  if (!labels || !Object.keys(labels).length) return value;
  if (typeof value === "string") {
    return Object.entries(labels).reduce((text, [from, to]) => text.split(from).join(to), value);
  }
  if (Array.isArray(value)) return value.map(item => exampleLabels(item, labels));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [exampleLabels(key, labels), exampleLabels(item, labels)]));
  return value;
}
