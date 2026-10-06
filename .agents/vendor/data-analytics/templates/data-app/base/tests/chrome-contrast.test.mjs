import assert from "node:assert/strict";
import test from "node:test";

import {
  chromeContrastRatio, compositeChromeColor, dataAppChromeColors, parseChromeColor,
} from "../src/chrome-contrast.js";

function assertBadgesReadable(colors, surface) {
  for (const variable of ["--data-app-safe-chrome-verified", "--data-app-safe-chrome-unverified"]) {
    for (const background of [surface, parseChromeColor(colors["--data-app-safe-chrome-track"])]) {
      const contrast = chromeContrastRatio(parseChromeColor(colors[variable]), background);
      assert.ok(contrast >= 3, `${variable} contrast is only ${contrast.toFixed(2)}:1`);
    }
  }
}

function assertReadable(colors, surface) {
  for (const variable of [
    "--data-app-safe-chrome-foreground",
    "--data-app-safe-chrome-secondary",
    "--data-app-safe-chrome-positive",
  ]) {
    const contrast = chromeContrastRatio(parseChromeColor(colors[variable]), surface);
    assert.ok(contrast >= 4.5, `${variable} contrast is only ${contrast.toFixed(2)}:1`);
  }
  assertBadgesReadable(colors, surface);
  const publishContrast = chromeContrastRatio(
    parseChromeColor(colors["--data-app-safe-chrome-publish-background"]),
    parseChromeColor(colors["--data-app-safe-chrome-publish-text"]),
  );
  assert.ok(publishContrast >= 4.5, `Publish contrast is only ${publishContrast.toFixed(2)}:1`);
}

test("protected chrome corrects unreadable custom foregrounds, secondary labels, and publishing", () => {
  for (const [background, foreground, secondary] of [
    ["rgb(21, 56, 212)", "rgb(70, 81, 138)", "rgb(70, 81, 138)"],
    ["rgb(23, 62, 47)", "rgb(21, 59, 45)", "rgb(93, 111, 97)"],
    ["rgb(25, 51, 73)", "rgb(25, 51, 73)", "rgb(83, 100, 119)"],
    ["rgb(229, 236, 220)", "rgb(215, 222, 207)", "rgb(192, 196, 183)"],
  ]) {
    const colors = dataAppChromeColors({ background, foreground, secondary });
    assertReadable(colors, parseChromeColor(background));
  }
});

test("protected chrome preserves readable authored brand colors and stable segmented-control ink", () => {
  const colors = dataAppChromeColors({
    background: "rgb(23, 62, 47)",
    foreground: "rgb(248, 241, 222)",
    secondary: "rgb(93, 111, 97)",
  });
  assert.equal(colors["--data-app-safe-chrome-foreground"], "rgb(248, 241, 222)");
  assert.equal(colors["--data-app-safe-chrome-indicator"], "rgb(248, 241, 222)");
  assert.ok(chromeContrastRatio(
    parseChromeColor(colors["--data-app-safe-chrome-indicator-text"]),
    parseChromeColor(colors["--data-app-safe-chrome-indicator"]),
  ) >= 4.5);
});

test("translucent theme colors are composited before protected chrome contrast is selected", () => {
  const underlay = parseChromeColor("rgb(6, 8, 17)");
  const translucent = parseChromeColor("color(srgb 0.0235294 0.0313726 0.0666667 / 0.95)");
  const surface = compositeChromeColor(translucent, underlay);
  assert.deepEqual(surface, [6, 8, 17, 1]);
  const colors = dataAppChromeColors({
    background: "color(srgb 0.0235294 0.0313726 0.0666667 / 0.95)",
    underlay: "rgb(6, 8, 17)",
    foreground: "rgb(237, 247, 255)",
    secondary: "rgb(145, 164, 189)",
  });
  assertReadable(colors, surface);
});

test("positive chrome preserves readable brand colors and rejects hostile authored tokens", () => {
  const hostile = dataAppChromeColors({
    background: "rgb(23, 62, 47)",
    foreground: "rgb(248, 241, 222)",
    positive: "rgb(23, 62, 47)",
  });
  assert.equal(hostile["--data-app-safe-chrome-positive"], hostile["--data-app-safe-chrome-foreground"],
    "A hostile positive token must fall back to readable protected chrome foreground");
  assertReadable(hostile, parseChromeColor("rgb(23, 62, 47)"));

  const branded = dataAppChromeColors({
    background: "rgb(255, 255, 255)",
    foreground: "rgb(23, 24, 26)",
    positive: "rgb(0, 100, 45)",
  });
  assert.equal(branded["--data-app-safe-chrome-positive"], "rgb(0, 100, 45)",
    "A readable authored positive brand color should remain green");
  assertReadable(branded, parseChromeColor("rgb(255, 255, 255)"));

  const translucent = dataAppChromeColors({
    background: "rgb(23, 62, 47)",
    foreground: "rgb(248, 241, 222)",
    positive: "rgba(248, 241, 222, 0.02)",
  });
  assert.equal(translucent["--data-app-safe-chrome-positive"], translucent["--data-app-safe-chrome-foreground"],
    "An almost transparent positive token cannot bypass protected chrome contrast");
});

test("verification badges use green and light gray independently of authored status colors", () => {
  const colors = dataAppChromeColors({ background: "#fff", positive: "#a00080", secondary: "#00642d" });
  assert.equal(colors["--data-app-safe-chrome-verified"], "rgb(0, 100, 45)",
    "The verified badge should be dark green on the default light surface");
  const gray = parseChromeColor(colors["--data-app-safe-chrome-unverified"]).slice(0, 3);
  assert.ok(gray.every((channel) => channel >= 128 && channel <= 160),
    "The unverified badge should remain light gray while meeting non-text contrast");
  assert.ok(Math.max(...gray) - Math.min(...gray) <= 2, "The unverified badge must remain neutral");
  assertReadable(colors, parseChromeColor("#fff"));

  for (const background of ["#060811", "#173e2f", "#1538d4", "#e5ecdc", "#808080"]) {
    const themed = dataAppChromeColors({ background, positive: background });
    const [red, green, blue] = parseChromeColor(themed["--data-app-safe-chrome-verified"]);
    const unverified = parseChromeColor(themed["--data-app-safe-chrome-unverified"]).slice(0, 3);
    assert.ok(green > red && green > blue, `Verified must stay green against ${background}`);
    assert.ok(Math.max(...unverified) - Math.min(...unverified) <= 2,
      `Unverified must stay neutral against ${background}`);
    assertBadgesReadable(themed, parseChromeColor(background));
  }
});
