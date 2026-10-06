const retiredStoryLabels = {
  "latest-above-target": "Growth keeps pulling ahead of plan",
  "latest-activation": "Activation improves week after week",
  "search-retention-tension": "Search grows, but retention trails",
};

// These comparisons are already visible in the figures. The bundled evidence
// supplies no additional contextual fact that needs an annotation.
export function operatingStoryAnnotations() {
  return { growth: [], activation: [], retention: [] };
}

export function withOperatingStory(base, saved, current, storyId) {
  const spec = saved ?? base;
  // Retire only this example's original wording. Preserve custom wording even
  // when its author reused an old ID, as well as unrelated notes and explicit [].
  const annotations = Object.hasOwn(spec, "annotations")
    ? spec.annotations ?? []
    : current;
  return { ...spec, annotations: annotations.filter((annotation) =>
    annotation.id !== storyId || annotation.label !== retiredStoryLabels[storyId]) };
}
