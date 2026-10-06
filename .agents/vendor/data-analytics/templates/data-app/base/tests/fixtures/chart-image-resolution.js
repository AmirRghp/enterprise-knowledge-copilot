import { chartImageResolution, renderChartImage, renderLiveChartImage } from "../../src/chart-image.js";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ChartRenderer } from "../../src/charting/ChartRenderer.jsx";

const artwork = document.getElementById("artwork");
const source = artwork.querySelector("svg");
const probe = document.getElementById("detail-probe");
for (let index = 0; index < 60; index += 1) {
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  for (const [name, value] of Object.entries({ x: 40 + index / 3, y: 40, width: 1 / 3, height: 10, fill: index % 2 ? "#fff" : "#000" })) {
    rect.setAttribute(name, String(value));
  }
  probe.append(rect);
}

const urls = [];
function assert(value, message) { if (!value) throw new Error(message); }
async function pixels(blob) {
  const bitmap = await createImageBitmap(blob), canvas = document.createElement("canvas");
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0); bitmap.close();
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

async function verifyHiddenText() {
  const baseline = await pixels((await renderLiveChartImage(artwork)).blob);
  const note = document.createElement("p");
  note.innerHTML = "<span>Accessibility-only annotation</span>";
  Object.assign(note.style, { position: "absolute", left: "20px", top: "100px", color: "red", margin: "0", whiteSpace: "nowrap" });
  artwork.append(note);
  try {
    const visible = await pixels((await renderLiveChartImage(artwork)).blob);
    assert(visible.some((value, index) => value !== baseline[index]), "Visible annotation fallback must be painted");
    for (const treatment of ["class", "clip-path", "clip"]) {
      note.className = treatment === "class" ? "visually-hidden" : "";
      note.style.clipPath = treatment === "clip-path" ? "inset(50%)" : "none";
      note.style.clip = treatment === "clip" ? "rect(0px, 0px, 0px, 0px)" : "auto";
      const hidden = await pixels((await renderLiveChartImage(artwork)).blob);
      assert(hidden.every((value, index) => value === baseline[index]), `${treatment}: hidden annotation must not change PNG pixels`);
    }
  } finally { note.remove(); }
}

async function verifySecondaryAxis() {
  const host = document.createElement("div");
  host.className = "axis-export-regression";
  document.body.append(host);
  const root = createRoot(host);
  try {
    for (const side of ["left", "right"]) {
      flushSync(() => root.render(React.createElement(ChartRenderer, {
        spec: { type: "line", x: "period", y: "rate", fields: ["rate", "count"], rightAxisFields: ["count"],
          startAtZero: false, showLegend: false, showXAxisLabel: false, showYAxisLabel: false, yAxisPosition: side },
        rows: [{ period: "A", rate: .11, count: 1e9 }, { period: "B", rate: .12, count: 1e9 + 25 },
          { period: "C", rate: .13, count: 1e9 + 50 }],
        height: 280, fixedAxisWidths: true,
      })));
      for (let frame = 0; frame < 90; frame += 1) {
        await new Promise(requestAnimationFrame);
        if (frame > 2 && host.textContent.includes("1,000,000,")) break;
      }
      const svg = host.querySelector(".recharts-wrapper svg"), bounds = svg?.getBoundingClientRect();
      const ticks = [...host.querySelectorAll("svg text")];
      assert(ticks.some(node => node.textContent.includes("1,000,000,")),
        `Secondary axis keeps distinct exact labels: ${JSON.stringify(ticks.map(node => node.textContent))}; ${host.textContent}`);
      for (const tick of ticks) {
        const box = tick.getBoundingClientRect();
        assert(box.left >= bounds.left - 1 && box.right <= bounds.right + 1,
          `${side} primary: axis label ${tick.textContent} stays inside exported SVG`);
      }
      await verifyPng(await renderLiveChartImage(host), chartImageResolution(host.offsetWidth, host.offsetHeight));
    }
  } finally { root.unmount(); host.remove(); }
}
async function verifyPng(result, expected) {
  const bytes = new DataView(await result.blob.arrayBuffer());
  assert(bytes.getUint32(0) === 0x89504e47 && bytes.getUint32(4) === 0x0d0a1a0a, "Valid PNG signature");
  const width = bytes.getUint32(16), height = bytes.getUint32(20);
  assert(width === expected.width && height === expected.height, `PNG header: ${width}x${height}, expected ${expected.width}x${expected.height}`);
  const bitmap = await createImageBitmap(result.blob);
  assert(bitmap.width === width && bitmap.height === height, "Decoded pixels match PNG header");
  bitmap.close();
  return `${width} × ${height}`;
}

async function probeTransitions(blob, scale) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0); bitmap.close();
  const root = artwork.getBoundingClientRect(), plot = source.getBoundingClientRect();
  const x = Math.round((plot.left - root.left + 40) * scale);
  const y = Math.round((plot.top - root.top + 45) * scale);
  const pixels = context.getImageData(x, y, Math.round(20 * scale), 1).data;
  let transitions = 0;
  for (let index = 4; index < pixels.length; index += 4) {
    if (Math.abs(pixels[index] - pixels[index - 4]) > 200) transitions += 1;
  }
  const red = [...pixels].filter((_, index) => index % 4 === 0);
  return { transitions, range: [Math.min(...red), Math.max(...red)] };
}

function showComparison(blob, label) {
  const figure = document.createElement("figure"), caption = document.createElement("figcaption"), image = document.createElement("img");
  caption.textContent = label; image.alt = label;
  image.src = URL.createObjectURL(blob); urls.push(image.src);
  figure.append(caption, image); document.getElementById("comparison").append(figure);
}

async function verifyTransparency(blob, transparent, textColor) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0); bitmap.close();
  // Empty corners must stay empty, including both colors of the preview checkerboard.
  for (const [x, y] of [[1, 1], [25, 1], [1, 25], [canvas.width - 2, canvas.height - 2]]) {
    assert(context.getImageData(x, y, 1, 1).data[3] === (transparent ? 0 : 255), "Background alpha matches the export option");
  }
  const root = artwork.getBoundingClientRect(), plot = source.getBoundingClientRect();
  const pixel = context.getImageData(Math.round((plot.left - root.left + 100) * 3),
    Math.round((plot.top - root.top + 160) * 3), 1, 1).data;
  assert(pixel[0] === 0 && pixel[1] === 102 && pixel[2] === 204 && pixel[3] === 255, "Chart stroke retains its color and opacity");
  const title = artwork.querySelector("h2").getBoundingClientRect();
  const text = context.getImageData(Math.round((title.left - root.left) * 3), Math.round((title.top - root.top) * 3),
    Math.round(title.width * 3), Math.round(title.height * 3)).data;
  let solidText = 0;
  for (let i = 0; i < text.length; i += 4) {
    if (text[i] === textColor && text[i + 1] === textColor && text[i + 2] === textColor && text[i + 3] === 255) solidText += 1;
  }
  assert(solidText > 100, "Text retains its selected appearance color");
}

document.getElementById("run").addEventListener("click", async () => {
  const button = document.getElementById("run"), results = document.getElementById("results");
  button.disabled = true; results.textContent = "Running…";
  urls.splice(0).forEach(url => URL.revokeObjectURL(url));
  document.getElementById("comparison").replaceChildren();
  const checks = [];
  try {
    for (const [name, width, height] of [["Slide", 920, 480], ["Document", 720, 400], ["Slack", 640, 400], ["Large custom", 2400, 400]]) {
      artwork.style.width = `${width}px`; artwork.style.height = `${height}px`;
      const result = await renderLiveChartImage(artwork);
      checks.push(`PASS ${name}: ${await verifyPng(result, chartImageResolution(width, height))} PNG pixels`);
      if (name === "Slack") {
        const reference = await renderLiveChartImage(artwork, { scale: 1 });
        await verifyPng(reference, chartImageResolution(width, height, 1));
        showComparison(reference.blob, "1× PNG — 640 × 400 pixels");
        showComparison(result.blob, "3× PNG — 1920 × 1200 pixels");
        const highDetail = await probeTransitions(result.blob, 3), lowDetail = await probeTransitions(reference.blob, 1);
        assert(highDetail.transitions >= 50 && lowDetail.transitions < 10, `Fine vector detail: 3x=${JSON.stringify(highDetail)}, 1x=${JSON.stringify(lowDetail)}`);
        checks.push(`PASS vector detail: ${highDetail.transitions} crisp one-pixel transitions at 3x; ${lowDetail.transitions} at 1x`);
      }
    }
    artwork.style.width = "640px"; artwork.style.height = "400px";
    for (const [appearance, background, foreground] of [["Light", "#fff", 23], ["Dark", "#282828", 255]]) {
      artwork.style.background = background;
      artwork.style.color = `rgb(${foreground}, ${foreground}, ${foreground})`;
      const solid = await renderLiveChartImage(artwork);
      await verifyTransparency(solid.blob, false, foreground);
      artwork.style.background = "transparent";
      const transparent = await renderLiveChartImage(artwork, { transparent: true });
      await verifyPng(transparent, { width: 1920, height: 1200 });
      await verifyTransparency(transparent.blob, true, foreground);
      checks.push(`PASS ${appearance}: transparent 3x PNG has zero background alpha; solid default, text and chart colors preserved`);
    }
    artwork.style.background = "#fff"; artwork.style.color = "#171717";
    const copied = await renderChartImage(artwork);
    assert(copied.width === 2040, "Quick-copy path also uses 3x independently of this screen");
    checks.push(`PASS quick-copy encoder: ${await verifyPng(copied, copied)} PNG pixels`);
    await verifyHiddenText();
    checks.push("PASS annotation visibility: visible notes are painted; accessibility-only and clipped copies leave PNG pixels unchanged");
    await verifySecondaryAxis();
    checks.push("PASS dual-axis export: wide exact secondary labels fit on both sides and encode as PNG");
    assert(document.querySelectorAll('#artwork').length === 1, "Temporary artwork clones were removed");
    results.textContent = checks.join("\n") + "\nAll PNG checks passed.";
  } catch (error) { results.textContent = checks.join("\n") + `\nFAIL ${error.message}`; }
  finally { artwork.style.width = "640px"; artwork.style.height = "400px"; artwork.style.background = "#fff"; artwork.style.color = "#171717"; button.disabled = false; }
});
