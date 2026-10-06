import assert from "node:assert/strict";
import test from "node:test";
import { chartAnnotationLayoutTokens as tokens, layoutChartAnnotations, chartAnnotationArrow } from "../src/charting/chart-annotation-layout.js";

const chartAnnotationReferenceArrow = (box, axis, labels = [], obstacles = []) =>
  chartAnnotationArrow(box, labels, obstacles, axis);

const measureText = (text) => [...text].length * 6;
const layout = (items, plot) => layoutChartAnnotations(items, plot, { measureText });
const item = (id, x, y, label = `Reviewed ${id}`, kind = "point", preferred) =>
  ({ id, kind, label, anchor: { x, y }, ...(preferred ? { preferred } : {}) });
const desktop = { x: 40, y: 20, width: 720, height: 280 };

test("reference connectors stay placeable across the stretched-card height feedback boundary", () => {
  // Recorded House chart geometry: showing a fallback note shrinks its SVG
  // from 250px to 220px. Both sizes fit the same complete two-line label, but
  // only the taller size rejects the center arrowhead's contact with a bar.
  const threshold = 305.9384615384615;
  const box = { x: 342.893075, y: 10, width: 57, height: 42, anchor: { x: threshold, y: 31 } };
  const before = structuredClone(box);
  for (const [height, barY, barHeight, valueY] of [
    [220, [31.6, 121.6], 47, [47.86, 137.86]],
    [250, [35.2, 140.2], 55, [55.46, 160.46]],
  ]) {
    const obstacles = [
      { x: 98, y: barY[0], width: 209.8462, height: barHeight },
      { x: 98, y: barY[1], width: 205.0769, height: barHeight },
      { x: threshold, y: 10, width: 0, height: height - 40 },
      { x: 312.8462, y: valueY[0], width: 22.046875, height: 14 },
      { x: 308.0769, y: valueY[1], width: 20.2265625, height: 14 },
    ];
    const preferred = chartAnnotationArrow(box, [], obstacles);
    assert.equal(Boolean(preferred), height === 220, "The original single-point connector reproduces the reversal");
    const arrow = chartAnnotationReferenceArrow(box, "y", [], obstacles);
    assert.ok(arrow, "Both responsive heights keep the full label on the plot instead of toggling the note");
    assert.equal(arrow.end.x, threshold, "The target remains the exact reviewed threshold line");
    assert.ok(arrow.end.y >= box.y && arrow.end.y <= box.y + box.height);
    assert.deepEqual(arrow, chartAnnotationArrow({ ...box, anchor: arrow.end }, [], obstacles),
      "Alternate reference points pass the same evidence and arrowhead clearance checks");
    if (preferred) assert.deepEqual(arrow, preferred, "Already-safe connectors retain their exact geometry");
  }
  assert.deepEqual(box, before, "The label, reviewed anchor, and caller geometry remain unchanged");
});

test("reference fallback preserves horizontal thresholds, other labels, and genuinely blocked notes", () => {
  const box = { x: 60, y: 80, width: 80, height: 42, anchor: { x: 20, y: 101 } };
  const line = { x: 20, y: 0, width: 0, height: 200 };
  const blocker = { x: 30, y: 98, width: 20, height: 6 };
  assert.equal(chartAnnotationArrow(box, [], [line, blocker]), null);
  const vertical = chartAnnotationReferenceArrow(box, "y", [], [line, blocker]);
  assert.ok(vertical);
  const transpose = ({ x, y, width, height, anchor }) => ({ x: y, y: x, width: height, height: width,
    ...(anchor ? { anchor: { x: anchor.y, y: anchor.x } } : {}) });
  const horizontal = chartAnnotationReferenceArrow(transpose(box), "x", [], [transpose(line), transpose(blocker)]);
  assert.ok(horizontal);
  assert.equal(horizontal.end.y, 20, "Horizontal references preserve the exact value coordinate too");
  assert.equal(horizontal.end.x, vertical.end.y);
  const wall = { x: 30, y: 70, width: 20, height: 70 };
  assert.equal(chartAnnotationReferenceArrow(box, "y", [], [line, wall]), null,
    "No safe reference connector still requires the complete fallback note");
  assert.equal(chartAnnotationReferenceArrow(box, "y", [wall], [line]), null,
    "Alternative connectors cannot pass through another annotation");
  assert.equal(chartAnnotationReferenceArrow({ ...box, anchor: { x: 40, y: 101 } }, "y"), null,
    "Nearby text remains undecorated rather than gaining unnecessary arrows");
});

function assertSafe(result, inputs, plot) {
  for (const box of result) {
    assert.ok([box.x, box.y, box.width, box.height, box.anchor.x, box.anchor.y].every(Number.isFinite));
    assert.ok(box.x >= plot.x && box.y >= plot.y);
    assert.ok(box.x + box.width <= plot.x + plot.width + 1e-7);
    assert.ok(box.y + box.height <= plot.y + plot.height + 1e-7);
    assert.deepEqual(box.anchor, inputs.find(({ id }) => id === box.id).anchor, "The connector retains the exact reviewed anchor");
    assert.equal(Object.hasOwn(box, "collapsed"), false, "There are no compact markers");
    assert.ok(box.lines.length >= 1 && box.lines.length <= 3);
    assert.ok(box.width <= tokens.maxWidth);
    assert.equal(box.height, box.lines.length * tokens.lineHeight + tokens.paddingY * 2);
    assert.ok(box.lines.every((line) => measureText(line) + tokens.paddingX * 2 <= box.width));
  }
  for (let index = 0; index < result.length; index++) for (const other of result.slice(index + 1)) {
    const box = result[index];
    assert.ok(box.x + box.width + tokens.gap <= other.x + 1e-7
      || other.x + other.width + tokens.gap <= box.x + 1e-7
      || box.y + box.height + tokens.gap <= other.y + 1e-7
      || other.y + other.height + tokens.gap <= box.y + 1e-7,
    `Placements ${box.id} and ${other.id} must not overlap`);
  }
}

test("desktop places concise full labels for every annotation kind", () => {
  assert.equal(tokens.fontSize, 14);
  const items = [item("target", 710, 160, "Operating target", "benchmark"),
    item("launch", 160, 25, "Release recorded", "event"),
    item("window", 355, 28, "Review window", "range"),
    item("high", 530, 240, "Observed high", "point")];
  const result = layout(items, desktop);
  assert.equal(result.length, 4);
  assert.deepEqual(result.map(({ lines }) => lines.join(" ")), items.map(({ label }) => label));
  assertSafe(result, items, desktop);
});

test("horizontal benchmark explanations and unequal text lines align to the plot edge",()=>{
  const plot={x:40,y:20,width:500,height:240};
  const entry=item("capacity",528,120,"Above 180 parcels/day requires written approval.","benchmark");
  const line={x:plot.x,y:120,width:plot.width,height:0};
  const run=obstacles=>layoutChartAnnotations([entry],plot,{measureText,obstacles:[line,...obstacles]});
  const [right]=run([]);
  assert.equal(right.x+right.width,plot.x+plot.width);
  assert.equal(right.textAnchor,"end");
  assert.equal(right.lines.length,2);assert.notEqual(measureText(right.lines[0]),measureText(right.lines[1]));
  assert.deepEqual(right.anchor,entry.anchor);
  const [left]=run([{x:plot.x+plot.width-220,y:plot.y,width:220,height:plot.height}]);
  assert.equal(left.x,plot.x);assert.equal(left.textAnchor,"start");
  const [nearLeft]=run([{x:plot.x+plot.width-220,y:plot.y,width:220,height:180}]);
  assert.equal(nearLeft.textAnchor,"start","Nearby left context beats a right-edge pocket far below its threshold");
  assert.deepEqual(run([{x:plot.x,y:plot.y,width:20,height:plot.height},
    {x:plot.x+plot.width-20,y:plot.y,width:20,height:plot.height}]),[],
    "When neither edge fits, use the full note rather than a floating middle column");
});

test("vertical benchmark lines retain their threshold association rather than forced horizontal edge placement",()=>{
  const entry={...item("vertical",260,32,"Approval threshold","benchmark","right"),horizontal:true};
  const [box]=layoutChartAnnotations([entry],{x:40,y:20,width:500,height:240},
    {measureText,obstacles:[{x:260,y:20,width:0,height:240}]});
  assert.ok(box.x>entry.anchor.x&&box.x+box.width<540);
  assert.equal(box.textAnchor,undefined);
  assert.deepEqual(box.anchor,entry.anchor);
});

test("preferred sides support horizontal and vertical chart orientation", () => {
  const plot = { x: 0, y: 0, width: 500, height: 300 };
  const left = item("left", 250, 150, "Target", "point", "left");
  const below = item("below", 250, 150, "Launch", "event", ["bottom", "right"]);
  const [leftBox] = layout([left], plot);
  const [belowBox] = layout([below], plot);
  assert.ok(leftBox.x + leftBox.width < left.anchor.x);
  assert.ok(belowBox.y > below.anchor.y);
  assertSafe([leftBox], [left], plot);
  assertSafe([belowBox], [below], plot);
});

test("a concise contextual phrase prefers balanced two-line text beside its reference", () => {
  const event = item("desk", 240, 150, "Second intake desk opened", "event");
  const [box] = layout([event], desktop);
  assert.deepEqual(box.lines, ["Second intake", "desk opened"]);
  assert.equal(box.x - event.anchor.x, tokens.anchorGap);
  assert.equal(chartAnnotationArrow(box), null, "Nearby two-line text does not need an arrow");
  assertSafe([box], [event], desktop);
});

test("range text starts 12px inside the band's leading edge near the plot top", () => {
  const entry = { ...item("maintenance",300,160,"Planned maintenance window","range"),
    range: {axis:"x",start:200,end:400} };
  const before = structuredClone(entry);
  const [box] = layout([entry],desktop);
  assert.equal(box.x+tokens.paddingX,212,"The text starts inside the band, not centered around it");
  assert.equal(box.y,desktop.y+12);
  assert.equal(box.lines.join(" "),entry.label);
  assert.equal(box.lines.length,2);
  assert.deepEqual(entry,before,"Layout does not revise the reviewed range or its center anchor");
  assertSafe([box],[entry],desktop);
});

test("horizontal and reversed projected ranges use the physical upper leading edge", () => {
  for (const [axis,start,end,x,y] of [
    ["x",400,200,212,32],
    ["y",120,220,52,132],
    ["y",220,120,52,132],
  ]) {
    const entry={...item("range",300,160,"Reviewed maintenance window","range"),range:{axis,start,end}};
    const [box]=layout([entry],desktop);
    assert.equal(box.x,x);
    assert.equal(box.y,y);
    assert.equal(box.lines.join(" "),entry.label);
    assertSafe([box],[entry],desktop);
  }
});

test("a narrow band keeps the text start inside while allowing complete text beyond the band", () => {
  const entry={...item("narrow",206,160,"Planned maintenance window","range"),
    range:{axis:"x",start:200,end:212}};
  const [box]=layout([entry],desktop);
  assert.equal(box.x,206,"For a band narrower than24px, use half its width as the inset");
  assert.ok(box.x+box.width>212,"Do not truncate the label to the shaded band's width");
  assert.equal(box.lines.join(" "),entry.label);
  assertSafe([box],[entry],desktop);
});

test("range text searches upward along its leading edge before accepting a centered label", () => {
  // The warehouse browser fixture's two cubic shoulders surround a two-day
  // closure. Its76px three-line label fits above the right shoulder only when
  // moved upward from the usual12px inset; the119px two-line shape cannot fit.
  const plot={x:65,y:10,width:641,height:260};
  const entry={...item("closure",385.5,140,"Warehouse closed for stock count","range"),
    range:{axis:"x",start:356.364,end:414.636}};
  const curves=[[[298.091,21.375],[317.515,21.375],[336.939,270],[356.364,270]],
    [[414.636,270],[434.061,270],[453.485,30.583],[472.909,26.25]]];
  const obstacles=curves.flatMap((points)=>{
    const sample=(t)=>[0,1].map((axis)=>(1-t)**3*points[0][axis]+3*(1-t)**2*t*points[1][axis]
      +3*(1-t)*t**2*points[2][axis]+t**3*points[3][axis]);
    return Array.from({length:80},(_,index)=>{
      const a=sample(index/80),b=sample((index+1)/80);
      return {x:Math.min(a[0],b[0])-2,y:Math.min(a[1],b[1])-2,
        width:Math.abs(a[0]-b[0])+4,height:Math.abs(a[1]-b[1])+4};
    });
  });
  obstacles.push({x:354.364,y:268,width:62.272,height:4},{x:381.5,y:136,width:8,height:8});
  const widths={Warehouse:72.365234375,"Warehouse closed":118.822265625,
    "closed for":64.3671875,"stock count":75.7626953125,"for stock count":97.4599609375,
    "closed for stock":103.3525390625,count:36.77734375};
  const [box]=layoutChartAnnotations([entry],plot,{measureText:(text)=>widths[text]??text.length*7,obstacles});
  assert.equal(box.x,entry.range.start+12);
  assert.deepEqual(box.lines,["Warehouse","closed for","stock count"]);
  assert.equal(box.width,76);
  assert.equal(box.height,60);
  assert.ok(box.y>=plot.y && box.y<plot.y+12,"Move along the leading edge, not back toward the band's center");
  assert.deepEqual(box.anchor,entry.anchor);
  for(const mark of obstacles) assert.ok(box.x+box.width+tokens.gap<=mark.x+1e-7
    || mark.x+mark.width+tokens.gap<=box.x+1e-7 || box.y+box.height+tokens.gap<=mark.y+1e-7
    || mark.y+mark.height+tokens.gap<=box.y+1e-7,"Full text must remain clear of the actual curved shoulders");
});

test("horizontal range text searches along the upper edge without shifting its band inset", () => {
  const plot={x:40,y:20,width:400,height:220};
  const entry={...item("horizontal",240,130,"Recorded inspection window","range"),
    range:{axis:"y",start:100,end:160}};
  const obstacles=[{x:40,y:100,width:110,height:80}];
  const [box]=layoutChartAnnotations([entry],plot,{measureText,obstacles});
  assert.equal(box.y,112);
  assert.ok(box.x>=158-1e-7,"Search along the edge past the blocking mark");
  assertSafe([box],[entry],plot);
});

test("an occluded or right-edge range preference falls back without covering data or leaving the plot", () => {
  const entry={...item("range",300,160,"Planned maintenance window","range"),
    range:{axis:"x",start:200,end:400}};
  const obstacles=[{x:200,y:20,width:180,height:100}];
  const [box]=layoutChartAnnotations([entry],desktop,{measureText,obstacles});
  assert.ok(box.x!==212 || box.y!==32,"The preferred band position is not mandatory when occluded");
  const [mark]=obstacles;
  assert.ok(box.x+box.width+tokens.gap<=mark.x+1e-7 || mark.x+mark.width+tokens.gap<=box.x+1e-7
    || box.y+box.height+tokens.gap<=mark.y+1e-7 || mark.y+mark.height+tokens.gap<=box.y+1e-7);
  assertSafe([box],[entry],desktop);
  const edge={...entry,range:{axis:"x",start:744,end:758},anchor:{x:751,y:160}};
  const [edgeBox]=layout([edge],desktop);
  assert.notEqual(edgeBox.x,751,"A preferred origin with no room for full text is rejected, not allowed to overflow");
  assert.equal(edgeBox.lines.join(" "),edge.label);
  assertSafe([edgeBox],[edge],desktop);
  assert.deepEqual(layoutChartAnnotations([entry],desktop,{measureText,obstacles:[{...desktop}]}),[],
    "When no full label fits anywhere, retain the existing full-text figure-note fallback");
});

test("range preferences respect earlier labels and leave point placement unchanged", () => {
  const point=item("point",110,150,"Measured peak","point");
  const first={...item("first",300,160,"Planned maintenance window","range"),range:{axis:"x",start:200,end:400}};
  const second={...first,id:"second",label:"Inspection window recorded"};
  const inputs=[point,first,second];
  const result=layout(inputs,desktop);
  assert.equal(result.length,3);
  assert.deepEqual(result[0],layout([point],desktop)[0]);
  assertSafe(result,inputs,desktop);
  assert.ok(result[2].x!==result[1].x || result[2].y!==result[1].y);
  assert.deepEqual(layout([{...point,range:first.range}],desktop),layout([point],desktop),
    "Only ranges can opt into the projected-band placement preference");
  for(const range of [{axis:"x",start:NaN,end:400},{axis:"z",start:200,end:400},
    {axis:"x",start:200,end:200},{axis:"x",start:800,end:900}])
    assert.deepEqual(layout([{...first,range}],desktop),layout([{...first,range:undefined}],desktop),
      "Invalid or out-of-plot band geometry cannot force an unsafe preferred origin");
});

test("a one-line-only slot preserves the complete phrase rather than forcing two lines outside", () => {
  const plot = { x: 10, y: 20, width: 300, height: 26 };
  const event = item("short", 60, 30, "Recorded maintenance", "event");
  const [box] = layout([event], plot);
  assert.deepEqual(box.lines, [event.label]);
  assertSafe([box], [event], plot);
});

test("a compact nearby wrap wins over a roomier distant placement", () => {
  const plot = { x: 0, y: 0, width: 500, height: 220 };
  const event = item("near", 260, 100, "Second intake desk opened", "event");
  const obstacles = [{ x: 256, y: 0, width: 8, height: 220 }, { x: 366, y: 0, width: 134, height: 220 }];
  const [box] = layoutChartAnnotations([event], plot, { measureText, obstacles });
  assert.deepEqual(box.lines, ["Second intake", "desk opened"]);
  assert.equal(box.x, 272);
  assert.equal(chartAnnotationArrow(box), null);
  assertSafe([box], [event], plot);
});

test("a complete two-line phrase gets an interior search before a three-line nearby wrap", () => {
  const plot = { x: 0, y: 0, width: 500, height: 220 };
  const event = item("period", 260, 100, "Warehouse closed for stock count", "event");
  const obstacles = [{ x: 256, y: 0, width: 8, height: 220 }, { x: 140, y: 40, width: 116, height: 140 },
    { x: 346, y: 0, width: 154, height: 220 }];
  const [box] = layoutChartAnnotations([event], plot, { measureText, obstacles });
  assert.equal(box.lines.length, 2);
  assert.equal(box.lines.join(" "), event.label);
  assert.ok(box.x + box.width <= 132);
  assertSafe([box], [event], plot);
});

test("natural two-line text wins over breaking a word beside the anchor", () => {
  const plot = { x: 0, y: 0, width: 320, height: 200 };
  const event = item("words", 68, 91, "Operational rollout", "event");
  const obstacles = [{ x: 169, y: 131, width: 88, height: 64 }, { x: 65, y: 52, width: 62, height: 71 },
    { x: 151, y: 34, width: 25, height: 70 }, { x: 130, y: 72, width: 56, height: 28 }];
  const [box] = layoutChartAnnotations([event], plot, { measureText, obstacles });
  assert.deepEqual(box.lines, ["Operational", "rollout"]);
  assertSafe([box], [event], plot);
});

test("colliding narrow-plot anchors place only full text and leave the rest for figure notes", () => {
  const plot = { x: 7, y: 11, width: 120, height: 160 };
  const items = Array.from({ length: 8 }, (_, index) => item(String(index), 67, 91,
    `Reviewed observation ${index}`, ["benchmark", "event", "range", "point"][index % 4]));
  const result = layout(items, plot);
  assert.ok(result.length > 0 && result.length < 8, "Unplaceable labels go to full-text figure notes");
  assertSafe(result, items, plot);
  assert.deepEqual(layout(items, plot), result, "Greedy placement is deterministic");
});

test("eight separated desktop anchors retain full labels", () => {
  const plot = { x: 0, y: 0, width: 960, height: 420 };
  const items = Array.from({ length: 8 }, (_, index) => item(String(index),
    110 + (index % 4) * 240, 105 + Math.floor(index / 4) * 210, `Observation ${index}`));
  const result = layout(items, plot);
  assert.equal(result.length, 8);
  assertSafe(result, items, plot);
});

test("wrapping preserves complete words and long tokens within three lines", () => {
  const items = [item("words", 180, 150, "A reviewed comparison period"),
    item("token", 540, 150, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")];
  const result = layout(items, desktop);
  assert.equal(result.length, 2);
  assert.ok(result.every(({ lines }) => lines.length >= 1 && lines.length <= 3));
  assert.equal(result[0].lines.join(" "), items[0].label);
  assert.equal(result[1].lines.join(""), items[1].label);
  assertSafe(result, items, desktop);
  const long = [item("long", 300, 100, "x".repeat(160))];
  const collapsed = layout(long, desktop);
  assert.deepEqual(collapsed, [], "Long text moves to the full-text figure note, never an ellipsis or number");
  assertSafe(collapsed, long, desktop);
});

test("unplaceable full labels are omitted from SVG, not replaced by badges", () => {
  const plot = { x: 0, y: 0, width: 170, height: 70 };
  const items = Array.from({ length: 8 }, (_, index) => item(String(index), 85, 35, "x".repeat(160)));
  assert.deepEqual(layout(items, plot), []);
  assert.deepEqual(layout([item("one", 13, 14)], { x: 3, y: 4, width: 20, height: 20 }), []);
});

test("failed full-plot searches preserve smaller wraps and reset with painted geometry", () => {
  const plot = { x: 0, y: 0, width: 300, height: 100 };
  const large = item("large", 150, 70, "A supported story about the business today");
  for (const [width, text] of [[50, "Fact"], [300, "Short contextual fact"]]) {
    const obstacles = [{ x: 0, y: 32, width: 300, height: 68 },
      { x: width + tokens.gap, y: 0, width: 300, height: 100 }];
    const small = item("small", 20, 20, text);
    const options = { measureText, obstacles };
    assert.deepEqual(layoutChartAnnotations([large], plot, options), []);
    const expected = layoutChartAnnotations([small], plot, options);
    assert.equal(expected.length, 1, "A shorter or narrower complete label still fits");
    assert.deepEqual(layoutChartAnnotations([large, small], plot, options), expected);
    assertSafe(expected, [small], plot);
  }
  assert.equal(layout([large], plot).length, 1, "A later render searches its own painted geometry");
});

test("invalid geometry never leaks nonfinite or out-of-plot positions", () => {
  const valid = item("valid", 50, 50, "Valid");
  const plot = { x: 0, y: 0, width: 100, height: 100 };
  for (const invalid of [null, {}, { ...plot, x: NaN }, { ...plot, width: Infinity },
    { ...plot, width: 19 }, { ...plot, height: -1 }, { ...plot, x: 1e308, width: 1e308 }])
    assert.deepEqual(layout([valid], invalid), []);
  const inputs = [item("outside", -1, 50), item("nan", NaN, 10), item("inf", 10, Infinity),
    { ...valid, id: "empty", label: " " }, valid, valid];
  const result = layout(inputs, plot);
  assert.deepEqual(result.map(({ id }) => id), ["valid"]);
  assertSafe(result, inputs, plot);
});

test("varied narrow-plot anchors keep every placed full label finite and separated", () => {
  let seed = 17;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const plot = { x: 7, y: 11, width: 120, height: 160 };
  for (let trial = 0; trial < 32; trial++) {
    const items = Array.from({ length: 8 }, (_, index) => item(String(index),
      plot.x + random() * plot.width, plot.y + random() * plot.height, `Reviewed observation ${index}`));
    const result = layout(items, plot);
    assert.ok(result.length <= 8);
    assertSafe(result, items, plot);
    assert.deepEqual(layout(items, plot), result);
  }
});

test("custom text measurement and frozen inputs stay pure", () => {
  const plot = Object.freeze({ x: 0, y: 0, width: 400, height: 200 });
  const entry = Object.freeze({ ...item("pure", 200, 100, "Measured label"), anchor: Object.freeze({ x: 200, y: 100 }) });
  const items = Object.freeze([entry]);
  const expected = layout(items, plot);
  assert.deepEqual(layoutChartAnnotations(items, plot, { measureText: (text) => ({ width: measureText(text) }) }), expected);
  const fallback = layoutChartAnnotations(items, plot, { measureText: () => NaN });
  assert.ok(fallback.every(({ x, y, width, height }) => [x, y, width, height].every(Number.isFinite)));
  assert.deepEqual(layout(items, plot), expected);
});

test("full labels avoid painted bars and their anchors", () => {
  const plot = { x: 50, y: 10, width: 270, height: 240 };
  const obstacles = [
    { x: 50, y: 70, width: 250, height: 38 },
    { x: 50, y: 136, width: 240, height: 38 },
    { x: 50, y: 202, width: 230, height: 38 },
  ];
  for (const label of ["Returns shift added", "Weekend intake began"]) {
    const items = [item("search", 280, 221, label)];
    const result = layoutChartAnnotations(items, plot, { measureText, obstacles });
    assert.equal(result.length, 1);
    assertSafe(result, items, plot);
    for (const mark of obstacles) {
      const box = result[0];
      assert.ok(box.x + box.width <= mark.x || mark.x + mark.width <= box.x
        || box.y + box.height <= mark.y || mark.y + mark.height <= box.y);
    }
  }
});

test("reserved chart whitespace preserves a label when data fills the plot", () => {
  const bounds = { x: 40, y: 0, width: 300, height: 252 };
  const marks = [{ x: 40, y: 52, width: 300, height: 200 }];
  const items = [item("filled", 190, 200, "A supported finding")];
  const [box] = layoutChartAnnotations(items, bounds, { measureText, obstacles: marks });
  assert.ok(box.lines.length > 0);
  assert.ok(box.y + box.height < 52);
  assertSafe([box], items, bounds);
  assert.deepEqual(layoutChartAnnotations(items, bounds, { measureText,
    obstacles: [{ ...bounds }] }), [], "Never cover the data just to fit an annotation");
});

test("interior search finds an off-grid pocket after the quick candidates miss", () => {
  const plot = { x: 0, y: 0, width: 310, height: 190 };
  const label = item("pocket", 20, 20, "A contextual fact");
  const obstacles = [
    { x: 0, y: 0, width: 310, height: 53 },
    { x: 0, y: 113, width: 310, height: 77 },
    { x: 0, y: 53, width: 113, height: 60 },
    { x: 253, y: 53, width: 57, height: 60 },
  ];
  // More than16 obstacles exercises the exact fallback independently of the
  // quick search's nearby-edge shortcut.
  const far = Array.from({length:20},(_,index)=>({x:-50,y:-50-index,width:1,height:1}));
  const result = layoutChartAnnotations([label], plot, {measureText,obstacles:[...far,...obstacles]});
  assert.equal(result.length,1);
  assert.ok(result[0].x>=121-1e-7 && result[0].x+result[0].width<=245+1e-7);
  assert.ok(result[0].y>=61-1e-7 && result[0].y+result[0].height<=105+1e-7);
  assertSafe(result,[label],plot);
});

test("exact and tolerance-sized tangent pockets remain legal during the event sweep", () => {
  const plot = Object.freeze({x:0,y:0,width:310,height:190});
  const label = item("tangent",20,20,"A contextual fact");
  for (const overlap of [0, 1.5e-7]) {
    const marks = [
      {x:0,y:0,width:310,height:53},
      {x:0,y:93-overlap,width:310,height:97+overlap},
      {x:0,y:53,width:113,height:40},
      {x:231-overlap,y:53,width:79+overlap,height:40},
    ];
    // Duplicated intervals must remain covered until both marks leave. Keep the
    // actual boundaries beyond the quick search's first 16 obstacle edges.
    const obstacles = Object.freeze([
      ...Array.from({length:20},(_,index)=>({x:-50,y:-50-index,width:1,height:1})),
      ...marks,...marks.map((mark)=>({...mark})),
    ].map(Object.freeze));
    const before = JSON.stringify(obstacles);
    const result = layoutChartAnnotations([label],plot,{measureText,obstacles});
    assert.equal(result.length,1,"The sweep must find even an exact tangent pocket");
    const [box] = result;
    assert.equal(box.width,102);
    assert.equal(box.height,24);
    assert.ok(Math.abs(box.x-121)<=1.01e-7 && Math.abs(box.y-61)<=1.01e-7);
    for (const mark of marks) assert.ok(box.x+box.width+tokens.gap<=mark.x+1e-7
      || mark.x+mark.width+tokens.gap<=box.x+1e-7
      || box.y+box.height+tokens.gap<=mark.y+1e-7
      || mark.y+mark.height+tokens.gap<=box.y+1e-7,"Use the exact renderer separation test");
    assertSafe(result,[label],plot);
    assert.equal(JSON.stringify(obstacles),before,"Search never changes painted geometry");
  }
});

test("full-text wrapping uses a 100px interior pocket rather than a figure note", () => {
  const plot={x:0,y:0,width:310,height:190};
  const label=item("narrow-pocket",20,20,"Alpha beta gamma delta");
  const obstacles=[
    ...Array.from({length:20},(_,index)=>({x:-50,y:-50-index,width:1,height:1})),
    {x:0,y:0,width:310,height:53},
    {x:0,y:129,width:310,height:61},
    {x:0,y:53,width:113,height:76},
    {x:229,y:53,width:81,height:76},
  ];
  const result=layoutChartAnnotations([label],plot,{measureText,obstacles});
  assert.equal(result.length,1);
  assert.equal(result[0].lines.join(" "),label.label);
  assert.equal(result[0].lines.length,2);
  assert.ok(result[0].width<=100 && result[0].height<=60);
  assert.ok(result[0].x>=121-1e-7 && result[0].x+result[0].width<=221+1e-7);
  assert.ok(result[0].y>=61-1e-7 && result[0].y+result[0].height<=121+1e-7);
  assertSafe(result,[label],plot);
});

test("5000 painted obstacles do not turn full-text fallback into a quadratic search", () => {
  const plot={x:50,y:10,width:720,height:260};
  const obstacles=Array.from({length:5000},(_,index)=>({
    x:50+(index/5000)*716,y:12+((index*37)%250),width:6,height:6,
  }));
  for (const kind of ["point","range"]) {
    const labels=Array.from({length:8},(_,index)=>({...item(String(index),80+index*80,220,
      "A supported story about the business",kind),
      ...(kind==="range"?{range:{axis:"x",start:280,end:420}}:{})}));
    const start=performance.now();
    const cpuStart=process.cpuUsage();
    const result=layoutChartAnnotations(labels,plot,{measureText:(text)=>text.length*7,obstacles});
    const elapsed=performance.now()-start;
    const cpu=process.cpuUsage(cpuStart);
    const cpuMs=(cpu.user+cpu.system)/1000;
    assert.deepEqual(result,[],"Dense marks leave no full-text pocket; callers keep the complete figure notes");
    // CPU time excludes scheduler pauses when this file runs beside the full
    // template suite, while still rejecting the former 20-second quadratic sweep.
    assert.ok(cpuMs<1000,`Eight ${kind} labels against 5000 marks took ${cpuMs.toFixed(1)}ms CPU (${elapsed.toFixed(1)}ms wall); expected under 1 second CPU`);
  }
});

test("filled actual plot uses notes instead of placing text in an imaginary outer band", () => {
  const plot={x:40,y:20,width:300,height:200};
  const labels=[item("full",190,100,"Documented context")];
  assert.deepEqual(layoutChartAnnotations(labels,plot,{measureText,obstacles:[{...plot}]}),[]);
});


test("near labels need no arrow and displaced arrows point from text to the exact anchor", () => {
  const box={id:"a",x:50,y:50,width:100,height:30,anchor:{x:162,y:65}};
  assert.equal(chartAnnotationArrow(box),null);
  const far={...box,anchor:{x:220,y:110}};
  const arrow=chartAnnotationArrow(far);
  assert.deepEqual(arrow.end,far.anchor);
  assert.deepEqual(arrow.start,{x:150,y:80});
  assert.notDeepEqual(arrow.left,arrow.right);
  assert.ok(arrow.left.x<arrow.end.x && arrow.right.x<arrow.end.x);
  assert.equal((arrow.path.match(/L /gu)||[]).length,3,"Shaft and two head strokes form an actual arrow");
  assert.equal(chartAnnotationArrow(far,[{x:175,y:80,width:35,height:40}]),null,
    "An optional arrow must not cross another label");
});

test("displaced non-bar connectors cannot cross unrelated painted evidence", () => {
  const box={id:"point",x:0,y:0,width:40,height:20,anchor:{x:200,y:120}};
  const blocker={x:100,y:50,width:20,height:30};
  assert.equal(chartAnnotationArrow(box,[],[blocker]),null,
    "A label-only collision check would draw the shaft through this unrelated curve or filled mark");
  const targetDot={x:196,y:116,width:8,height:8};
  const targetReference={x:198,y:0,width:4,height:220};
  for(const target of [targetDot,targetReference]){
    const arrow=chartAnnotationArrow(box,[],[target]);
    assert.ok(arrow,"The intended point or reference may meet its connector at the exact anchor");
    assert.deepEqual(arrow.end,box.anchor);
    assert.equal(chartAnnotationArrow(box,[],[target,blocker]),null,
      "Contact with the target never permits crossing a second painted mark");
  }
  assert.equal(chartAnnotationArrow(box,[],[{x:90,y:40,width:115,height:90}]),null,
    "An area containing the anchor cannot be ignored along the entire connector");
  const clear=chartAnnotationArrow(box);
  const headOnly={x:clear.right.x-1,y:clear.right.y-1,width:2,height:2};
  assert.equal(chartAnnotationArrow(box,[],[headOnly]),null,"Arrowheads also avoid unrelated evidence");
});
