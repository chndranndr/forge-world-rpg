import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

test("mockup validates definitions, escapes text, renders every screen and preserves demo defaults", () => {
  const nodes = new Map();
  const node = (key) => {
    if (!nodes.has(key))
      nodes.set(key, {
        innerHTML: "",
        style: {},
        value: "",
        scrollIntoView() {},
      });
    return nodes.get(key);
  };
  const context = vm.createContext({
    structuredClone,
    crypto: { randomUUID: () => "imported-template-id" },
    localStorage: { getItem: () => null, setItem() {} },
    document: { querySelector: node, addEventListener() {} },
    location: { hash: "" },
    window: { addEventListener() {} },
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(
    readFileSync(new URL("app.js", import.meta.url), "utf8"),
    context,
  );
  assert.equal(vm.runInContext("validate(sample).length", context), 0);
  assert.match(
    vm.runInContext('escapeHtml("<script>")', context),
    /&lt;script&gt;/,
  );
  assert.ok(
    vm.runInContext('validate({...clone(sample), title: ""}).length', context) >
      0,
  );
  assert.ok(
    vm.runInContext(
      'validate({...clone(sample), attributes: [{name:"Invalid",min:5,max:3,value:4}]}).length',
      context,
    ) > 0,
  );
  for (const route of [
    "library",
    "story",
    "player",
    "inventory",
    "people",
    "facts",
    "settings",
  ]) {
    context.location.hash = `#${route}`;
    vm.runInContext("render()", context);
    assert.ok(node("#app").innerHTML.length > 100, route);
  }
  vm.runInContext("draft = clone(sample); editor();", context);
  assert.match(node("#app").innerHTML, /Starting inventory/);
  assert.match(node("#app").innerHTML, /Private knowledge/);
  assert.match(node("#app").innerHTML, /Import JSON template/);
  assert.match(node("#app").innerHTML, /Export JSON template/);
  const template = vm.runInContext("templateBundle(sample)", context);
  assert.equal(template.format, "fworld-mockup-template");
  assert.equal("session" in template.game, false);
  assert.equal("id" in template.game, false);
  assert.equal("apiKey" in template.game, false);
  const imported = vm.runInContext(
    "readTemplate(templateBundle(sample))",
    context,
  );
  assert.equal(imported.title, "Summer in Kamakura");
  assert.equal(imported.id, "imported-template-id");
  assert.equal(imported.session, null);
  assert.throws(() =>
    vm.runInContext("readTemplate({format:'unknown'})", context),
  );
  assert.throws(() =>
    vm.runInContext(
      "readTemplate({format:'fworld-mockup-template',version:1,game:{}})",
      context,
    ),
  );
  vm.runInContext("data.games[0].title = 'Changed';", context);
  assert.equal(vm.runInContext("sample.title", context), "Summer in Kamakura");
});
