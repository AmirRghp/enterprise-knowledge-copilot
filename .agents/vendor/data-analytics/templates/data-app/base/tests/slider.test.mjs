import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  clampSliderValue,
  layoutRangeSliderLabels,
  layoutSingleSliderLabels,
  normalizeMinDistance,
  normalizeRangeValue,
  normalizeSliderBounds,
  sliderPercent,
  sliderValueAtPosition,
  updateRangeValue,
} from "../src/components/slider-math.js";

test("slider math handles fractional and collapsed bounds", () => {
  assert.equal(sliderPercent(0, 0, 0.5), 0);
  assert.equal(sliderPercent(0.25, 0, 0.5), 50);
  assert.equal(sliderPercent(0.5, 0, 0.5), 100);
  assert.equal(sliderPercent(4, 4, 4), 0);
  assert.ok(Number.isFinite(sliderPercent(4, 4, 4)));
  assert.equal(clampSliderValue(3, 4, 4), 4);
});

test("touch slider positions account for the wider thumb and snap to steps", () => {
  const rect = { left: 20, width: 244 };
  assert.equal(sliderValueAtPosition(20, rect, -20, 30, 5, 44), -20);
  assert.equal(sliderValueAtPosition(142, rect, -20, 30, 5, 44), 5);
  assert.equal(sliderValueAtPosition(264, rect, -20, 30, 5, 44), 30);
});

test("slider math normalizes bounds and clamps values", () => {
  assert.deepEqual(normalizeSliderBounds(10, -10), { minimum: -10, maximum: 10 });
  assert.equal(clampSliderValue(-20, -10, 10), -10);
  assert.equal(clampSliderValue(20, -10, 10), 10);
  assert.equal(clampSliderValue(Number.NaN, -10, 10), -10);
});

test("range values stay ordered and may touch by default", () => {
  assert.deepEqual(normalizeRangeValue([80, 20], 0, 100), [20, 80]);
  assert.deepEqual(normalizeRangeValue([50, 50], 0, 100), [50, 50]);
  assert.deepEqual(normalizeRangeValue([3, 5], 4, 4, 10), [4, 4]);
  assert.deepEqual(updateRangeValue([40, 60], "lower", 80, 0, 100), [60, 60]);
  assert.deepEqual(updateRangeValue([40, 60], "upper", 20, 0, 100), [40, 40]);
});

test("range values respect a clamped minimum distance", () => {
  assert.equal(normalizeMinDistance(-5, 0, 100), 0);
  assert.equal(normalizeMinDistance(200, 0, 100), 100);
  assert.deepEqual(normalizeRangeValue([45, 50], 0, 100, 10), [45, 55]);
  assert.deepEqual(normalizeRangeValue([98, 99], 0, 100, 10), [90, 100]);
  assert.deepEqual(updateRangeValue([40, 60], "lower", 58, 0, 100, 10), [50, 60]);
  assert.deepEqual(updateRangeValue([40, 60], "upper", 42, 0, 100, 10), [40, 50]);
});

test("range label layout separates touching values on narrow controls", () => {
  const layout = layoutRangeSliderLabels({
    width: 100,
    startPercent: 50,
    endPercent: 50,
    lowerWidth: 34,
    upperWidth: 34,
    minimumBoundWidth: 18,
    maximumBoundWidth: 24,
  });
  assert.ok(layout.upperLeft - layout.lowerLeft >= 46);
  assert.equal(layout.lowerPlacement, "edge");
  assert.equal(layout.upperPlacement, "edge");
});

test("single-slider labels fit inside the track without overlapping visible endpoints", () => {
  for (const width of [100, 280, 720]) for (const percent of [0, 10, 40, 70, 100]) {
    const layout = layoutSingleSliderLabels({ width, percent, valueWidth: 34, minimumBoundWidth: 18, maximumBoundWidth: 30 });
    assert.ok(layout.valueLeft >= 8);
    assert.ok(layout.valueLeft + 34 <= width - 8);
    if (layout.showMinimum) assert.ok(layout.valueLeft >= 8 + 18 + 6);
    if (layout.showMaximum) assert.ok(layout.valueLeft + 34 + 6 <= width - 8 - 30);
  }
});

test("Slider and RangeSlider preserve the shared source contract", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../src/components/Slider.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/form-controls.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /export function Slider\(/u);
  assert.match(component, /export function RangeSlider\(/u);
  assert.equal((component.match(/labelPlacement = "outside"/gu) ?? []).length, 2,
    "Both controls must support the same label-placement API");
  assert.equal((component.match(/layout: layoutMode = "stacked"/gu) ?? []).length, 2,
    "Both controls must expose the same reusable inline-layout option");
  assert.equal((component.match(/showBounds = false/gu) ?? []).length, 2,
    "Single and double-range sliders must keep endpoint labels hidden by default");
  assert.equal((component.match(/data-layout=\{resolvedLayout\}/gu) ?? []).length, 2);
  assert.equal((component.match(/type="range"/gu) ?? []).length, 3,
    "The single slider and both range thumbs must use native range inputs");
  assert.match(component, /minDistance = 0/u);
  assert.match(component, /aria-labelledby=\{labelId\}/u);
  assert.match(component, /aria-labelledby=\{`\$\{labelId\} \$\{lowerLabelId\}`\}/u);
  assert.match(component, /aria-labelledby=\{`\$\{labelId\} \$\{upperLabelId\}`\}/u);
  assert.match(component, /new ResizeObserver\(update\)/u);
  assert.equal((component.match(/data-slider data-selection-mode=/gu) ?? []).length, 2,
    "Both public controls need the stable drag and editing exclusion boundary");
  assert.match(component, /data-active-thumb=\{renderedActiveThumb\}/u);
  assert.equal((component.match(/"--data-slider-end-position": `\$\{[^}]+\}%`/gu) ?? []).length, 2,
    "Single and dual fills must use raw percentages and reach the visible track end");
  assert.match(component, /name=\{lowerName \?\? name\}/u);
  assert.match(component, /name=\{upperName \?\? name\}/u,
    "A shared range name must submit two ordered values unless explicit names are supplied");
  assert.equal((component.match(/type="range" min=\{bounds\.minimum\} max=\{bounds\.maximum\}/gu) ?? []).length, 2,
    "Both range thumbs must retain the same coordinate system and step base");
  assert.match(component, /boundaryActiveThumb \?\? activeThumb \?\? "upper"/u,
    "A collapsed boundary must remain reopenable after controlled parent updates");
  assert.match(component, /onChange\?\.\(updateRangeValue\(/u,
    "RangeSlider must emit its normalized pair on every native change");
  assert.match(styles, /data-active-thumb="lower"[\s\S]*data-slider-input--lower/u);
  assert.match(styles, /data-active-thumb="upper"[\s\S]*data-slider-input--upper/u);
  assert.match(styles,
    /\.data-slider-handle--upper\s*\{[^}]*left:\s*clamp\(8px,[^}]*100% - 8px/su,
    "The visible pip must stay eight pixels from either edge");
  assert.match(component, /"--data-slider-start-position": `\$\{startPercent\}%`/u);
  assert.match(component, /"--data-slider-end-position": `\$\{endPercent\}%`/u,
    "The dual-range fill and pips must share the same percentage geometry");
  assert.match(styles,
    /\.data-slider--range \.data-slider-value\s*\{[^}]*font-size:\s*14px/su,
    "Dual-range values must remain 14px");
  assert.match(styles,
    /\.data-slider--single \.data-slider-selection\s*\{[^}]*min-width:\s*min\(16px, 100%\)/su,
    "A zero-value single slider must retain a sixteen-pixel cap around its eight-pixel pip inset");
  assert.match(styles,
    /\.data-slider:not\(\[data-disabled\]\) \.data-slider-control:hover \.data-slider-selection\s*\{[^}]*var\(--text\) 14%/su,
    "Hover must strengthen only the selected-area hairline");
  assert.match(styles,
    /\.data-slider-handle\s*\{[^}]*opacity:\s*\.55/su,
    "Slider pips must remain visible at rest");
  assert.match(styles,
    /\.data-slider-label\s*\{[^}]*color:\s*var\(--secondary\)/su,
    "The label for the whole control must retain the secondary text color");
  assert.match(styles,
    /\.data-slider--range \.data-slider-value\s*\{[^}]*color:\s*var\(--text\)/su,
    "The two selected range values must use the primary text color");
  assert.match(styles,
    /--data-slider-control-height:\s*var\(--data-control-height, 32px\);[\s\S]*--data-slider-control-padding:\s*var\(--space-3, 12px\)/u,
    "Sliders must share the default control height and horizontal inset");
  assert.match(styles, /\.data-slider-control\s*\{[^}]*border-radius:\s*var\(--control-radius\)/su);
  assert.match(styles,
    /\.data-slider\[data-layout="inline"\]\s*\{[^}]*grid-template-columns:[^}]*--data-slider-inline-label-width[^}]*minmax\(0, 1fr\)[^}]*column-gap:\s*var\(--data-slider-inline-gap\)/su,
    "Inline sliders must reserve a left label column and a deliberately inset control column");
  assert.match(component,
    /placement !== "inline" && <SliderLabel controlId=\{controlId\}/u,
    "The single slider label must remain above the control unless inline placement is requested");
  assert.match(component,
    /<div ref=\{controlRef\} className="data-slider-control"[\s\S]*?>\s*\{placement === "inline" && <SliderLabel/u,
    "The inline single-slider label must sit inside the left side of the control");
  assert.match(component,
    /<output ref=\{valueRef\} htmlFor=\{controlId\}[\s\S]*data-slider-value--end/u,
    "The default single slider retains the pinned current value");
  assert.match(styles,
    /\.data-slider-value--end\s*\{[^}]*right:\s*var\(--data-slider-control-padding\)[^}]*font-size:\s*14px/su,
    "The pinned current value must remain 14px");
  assert.match(component, /data-show-bounds=\{showBounds \|\| undefined\}/u);
  assert.match(component, /showBounds && valueLayout \? \{ left: valueLayout.valueLeft, right: "auto" \}/u,
    "Optional bounds use collision-aware placement inside the track");
  assert.match(styles,
    /\.data-slider\[data-label-placement="inline"\] \.data-slider-label--inline\s*\{[^}]*position:\s*absolute[^}]*left:\s*var\(--data-slider-control-padding\)/su,
    "Inline labels for single and dual sliders must be pinned to the left edge of the control");
  assert.equal((component.match(/placement === "inline" && <SliderLabel/gu) ?? []).length, 2,
    "Single and dual sliders must render inline labels inside their controls");
  assert.match(component, /"--data-slider-midpoint": `\$\{\(startPercent \+ endPercent\) \/ 2\}%`/u);
  assert.match(component, /next\.centerInlineLabel = inlineLabelWidth > 0[\s\S]*control\.clientWidth \* startPercent/u,
    "The inline label must move only when the active band overlaps it in pixels");
  assert.match(component, /centerInlineLabel[\s\S]*?left: "var\(--data-slider-control-padding\)"[\s\S]*?right: "var\(--data-slider-control-padding\)"/u,
    "Centered-label dual-range values must stay pinned to the two outer edges");
  assert.match(styles,
    /\.data-slider--range\[data-center-inline-label\] \.data-slider-label--inline\s*\{[^}]*left:\s*var\(--data-slider-midpoint\)[^}]*translateX\(-50%\)/su,
    "The inline dual-range label must stay centered within its selected band");
  assert.match(styles,
    /\.data-slider-selection\s*\{[^}]*box-shadow:[^;}]*inset 0 0 0 1px[^}]*var\(--text\) 9%/su,
    "The selected range must retain the reference hairline shadow");
  assert.match(styles,
    /\.data-slider-track\s*\{[^}]*inset:\s*-1px[^}]*overflow:\s*visible/su,
    "The fill must extend over the control border so its hairline replaces rather than doubles it");
  assert.match(styles,
    /@container data-slider \(max-width:\s*520px\)[\s\S]*\.data-slider\[data-layout="inline"\] > \.data-slider-label--outside[\s\S]*grid-column:\s*1 \/ -1/su,
    "Inline sliders must stack based on their own available width");
  assert.match(styles, /prefers-reduced-motion:\s*reduce/u);
});
