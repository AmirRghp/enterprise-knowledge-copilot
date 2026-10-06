import test from "node:test";
import assert from "node:assert/strict";
import {
  chartColorIdentity,
  chartColorContext,
  colorNameFromHex,
  chartColorOptions,
  hexToHsv,
  hsvToHex,
  resolvedColorHex,
} from "../src/components/chart-color-utils.js";

const semanticWauColor = "oklch(from var(--chart-1) l max(c, 0.16) calc(h + 180))";

test("color identities describe exact theme slots and semantic roles without guessing hues", () => {
  for (let slot = 1; slot <= 8; slot += 1) {
    const token = `var(--chart-${slot})`;
    const blended = `color-mix(in srgb, ${token} 42%, var(--surface))`;
    assert.deepEqual(chartColorIdentity(token), {
      label: `Theme color ${slot}`,
      explicitColor: token,
      customHex: null,
    });
    assert.deepEqual(chartColorIdentity(blended), {
      label: `Theme color ${slot}, blended`,
      explicitColor: blended,
      customHex: null,
    });
  }
  for (const [token, label] of [
    ["var(--secondary)", "Secondary"],
    ["var(--positive)", "Positive"],
    ["var(--negative)", "Negative"],
  ]) {
    assert.deepEqual(chartColorIdentity(token), { label, explicitColor: token, customHex: null });
  }
  assert.deepEqual(chartColorIdentity("#aBcDeF"), {
    label: "Custom #ABCDEF",
    explicitColor: "#aBcDeF",
    customHex: "#ABCDEF",
  });
});

test("automatic and relative CSS colors cannot impersonate an embedded palette token", () => {
  for (const color of [undefined, "var(--chart-1)", semanticWauColor, "#0285ff"]) {
    assert.deepEqual(chartColorIdentity(color, { automatic: true }), {
      label: "Automatic",
      explicitColor: null,
      customHex: null,
    });
  }
  for (const color of [
    semanticWauColor,
    "color-mix(in srgb, var(--chart-1) 55%, var(--surface))",
    "var(--chart-1, #0285ff)",
    "var(--chart-10)",
    "rgb(255 136 0)",
    "#f80",
  ]) {
    assert.deepEqual(chartColorIdentity(color), {
      label: "Custom color",
      explicitColor: color,
      customHex: null,
    });
  }
});

test("palette choices retain their original tokens and select only exact explicit overrides", () => {
  const slots = Array.from({ length: 7 }, (_, index) => `var(--chart-${index + 1})`);
  const tokens = [
    ...slots,
    "var(--secondary)",
    ...slots.map((token) => `color-mix(in srgb, ${token} 42%, var(--surface))`),
  ];
  assert.deepEqual(
    chartColorOptions.map((option) => option.token),
    tokens,
  );
  assert.deepEqual(
    chartColorOptions.map((option) => option.label),
    tokens.map((token) => chartColorIdentity(token).label),
  );
  assert.equal(new Set(tokens).size, 15);
  assert.equal(tokens.includes("var(--chart-8)"), false);

  const selected = (color, automatic = false) => {
    const identity = chartColorIdentity(color, { automatic });
    return chartColorOptions.filter(({ token }) => identity.explicitColor === token).map(({ token }) => token);
  };
  assert.deepEqual(selected(semanticWauColor, true), []);
  assert.deepEqual(selected(semanticWauColor), []);
  assert.deepEqual(selected("var(--chart-1)", true), []);
  assert.deepEqual(selected("#0285ff"), []);
  assert.deepEqual(selected("var(--chart-1)"), ["var(--chart-1)"]);
  assert.deepEqual(selected("var(--secondary)"), ["var(--secondary)"]);
  assert.deepEqual(selected(tokens[8]), [tokens[8]]);
});

test("custom picker resolves the exact CSS expression in its own document and theme scope", () => {
  let attached = false;
  let removed = false;
  const probe = {
    style: {},
    remove() {
      removed = true;
      attached = false;
    },
  };
  const context = {
    fillStyle: "",
    fillRect(...args) {
      assert.deepEqual(args, [0, 0, 1, 1]);
    },
    getImageData(...args) {
      assert.deepEqual(args, [0, 0, 1, 1]);
      return { data: new Uint8ClampedArray([255, 136, 0, 255]) };
    },
  };
  const canvas = {
    getContext(kind) {
      assert.equal(kind, "2d");
      return context;
    },
  };
  const ownerDocument = {
    defaultView: {
      getComputedStyle(element) {
        assert.equal(element, probe);
        assert.equal(attached, true);
        assert.equal(probe.style.color, semanticWauColor);
        return { color: "rgb(255, 136, 0)" };
      },
    },
    createElement(tag) {
      if (tag === "span") return probe;
      assert.equal(tag, "canvas");
      return canvas;
    },
  };
  const parent = {
    ownerDocument,
    append(element) {
      assert.equal(element, probe);
      attached = true;
    },
  };
  assert.equal(resolvedColorHex(semanticWauColor, parent), "#ff8800");
  assert.equal(context.fillStyle, "rgb(255, 136, 0)");
  assert.equal(removed, true);
  assert.equal(canvas.width, 1);
  assert.equal(canvas.height, 1);
  assert.equal(resolvedColorHex("#AABBCC", null), "#AABBCC");
});

test("editor portals carry only referenced authored color tokens without changing the spec", () => {
  const spec = { type: "line", colors: { East: "var(--regional-east)", West: "color-mix(in srgb, var(--regional-west) 60%, var(--surface))" } };
  const before = JSON.stringify(spec);
  const values = { "--regional-east": " light-dark(#ff66ad, #ff8cc1) ", "--regional-west": "#0285ff", "--surface": "#fff", "--layout-width": "1600px" };
  assert.deepEqual(chartColorContext(spec, { getPropertyValue: key => values[key] ?? "" }), {
    "--regional-east": "light-dark(#ff66ad, #ff8cc1)", "--regional-west": "#0285ff", "--surface": "#fff",
  });
  assert.equal(JSON.stringify(spec), before);
  assert.deepEqual(chartColorContext(spec, null), {});
});

test("custom picker HSV coordinates round-trip the selected hex", () => {
  for (const hex of ["#2a6fcf", "#0285ff", "#000000", "#ffffff", "#808080", "#ff0000", "#00ff00", "#0000ff"]) {
    assert.equal(hsvToHex(hexToHsv(hex)), hex);
  }
});
test("custom picker field matches white, hue, and black corners", () => {
  assert.equal(hsvToHex({ hue: 240, saturation: 0, value: 100 }), "#ffffff");
  assert.equal(hsvToHex({ hue: 240, saturation: 100, value: 100 }), "#0000ff");
  assert.equal(hsvToHex({ hue: 240, saturation: 100, value: 0 }), "#000000");
});

test("theme palette labels describe the resolved color rather than the chart token position", () => {
  const colors = {
    "#b6ff3b": "Lime",
    "#ff4fd8": "Magenta",
    "#00e6ff": "Cyan",
    "#0285ff": "Blue",
    "#924ff7": "Purple",
    "#04b84c": "Green",
    "#fb6a22": "Orange",
    "#ff66ad": "Pink",
    "#ffc300": "Yellow",
    "#fa423e": "Red",
    "#8f8f8f": "Gray",
    "#ffffff": "White",
    "#000000": "Black",
  };
  for (const [color, expected] of Object.entries(colors)) {
    assert.equal(colorNameFromHex(color), expected, `${color} should be named for its actual hue`);
  }
  assert.equal(colorNameFromHex("var(--chart-1)"), "Theme color");
});
