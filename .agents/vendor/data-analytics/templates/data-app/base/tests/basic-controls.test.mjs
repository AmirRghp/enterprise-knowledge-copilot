import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, SegmentedControl, Switch, ExecutiveSummary;
before(async () => {
  server = await createServer({root:fileURLToPath(new URL("../",import.meta.url)),configFile:false,
    appType:"custom",logLevel:"silent",server:{middlewareMode:true}});
  ({SegmentedControl} = await server.ssrLoadModule("/src/components/SegmentedControl.jsx"));
  ({Switch} = await server.ssrLoadModule("/src/components/Switch.jsx"));
  ({ExecutiveSummary} = await server.ssrLoadModule("/src/components/ExecutiveSummary.jsx"));
});
after(async () => { await server?.close(); });

// Exercise the rendered controls and their callbacks, not their source spelling.
function renderControl(Component, props) {
  let tree;
  function Probe() { tree = Component(props); return tree; }
  const html = renderToStaticMarkup(React.createElement(Probe));
  const elements = [];
  function visit(element) {
    if (!React.isValidElement(element)) return;
    elements.push(element);
    React.Children.forEach(element.props.children,visit);
  }
  visit(tree);
  return {html,elements,buttons:elements.filter(element=>element.type === "button")};
}

test("single selection emits the chosen value and reflects controlled selection", () => {
  const changes = [];
  const props = {options:["Week","Month"],value:"Week",ariaLabel:"Interval",onChange:value=>changes.push(value)};
  const first = renderControl(SegmentedControl,props);
  assert.match(first.html,/role="group" aria-label="Interval"/u);
  assert.deepEqual(first.buttons.map(button=>button.props["aria-pressed"]),[true,false]);
  first.buttons[1].props.onClick();
  assert.deepEqual(changes,["Month"]);
  assert.deepEqual(renderControl(SegmentedControl,{...props,value:changes[0]}).buttons.map(button=>button.props["aria-pressed"]),[false,true]);
});

test("multiple selection adds and removes values without mutating the reviewed selection", () => {
  const selected = ["A"], changes = [];
  const props = {options:["A","B",{value:"C",disabled:true}],selectionMode:"multiple",value:selected,onChange:value=>changes.push(value)};
  const control = renderControl(SegmentedControl,props);
  control.buttons[0].props.onClick();
  control.buttons[1].props.onClick();
  assert.deepEqual(changes,[[],["A","B"]]);
  assert.deepEqual(selected,["A"]);
  assert.equal(control.buttons[2].props.disabled,true);
  assert.ok(renderControl(SegmentedControl,{...props,disabled:true}).buttons.every(button=>button.props.disabled));
});

test("switch callbacks and accessible state follow the controlled value", () => {
  const changes = [];
  for (const checked of [false,true]) {
    const {buttons,html} = renderControl(Switch,{label:"Previous period",checked,onChange:value=>changes.push(value)});
    assert.match(html,/role="switch" aria-label="Previous period"/u);
    assert.equal(buttons[0].props["aria-checked"],checked);
    buttons[0].props.onClick();
  }
  assert.deepEqual(changes,[true,false]);
  assert.equal(renderControl(Switch,{disabled:true}).buttons[0].props.disabled,true);
});

test("summary disclosure connects its trigger to the controlled or initially open panel", () => {
  for (const props of [{open:false},{open:true},{defaultOpen:true}]) {
    const changes = [];
    const {buttons,elements} = renderControl(ExecutiveSummary,{...props,preview:"Short preview",children:"Reviewed details",onOpenChange:value=>changes.push(value)});
    const button = buttons[0], panel = elements.find(element=>element.props.role === "region");
    const expanded = props.open ?? props.defaultOpen;
    assert.equal(button.props["aria-expanded"],expanded);
    assert.equal(panel.props.hidden,!expanded);
    assert.equal(button.props["aria-controls"],panel.props.id);
    assert.equal(panel.props["aria-labelledby"],button.props.id);
    button.props.onClick();
    assert.deepEqual(changes,[!expanded]);
  }
});
