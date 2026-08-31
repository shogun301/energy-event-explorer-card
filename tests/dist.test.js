import test from "node:test";
import assert from "node:assert/strict";

test("built bundle registers all public custom elements", async () => {
  const registry = new Map();
  globalThis.HTMLElement = class {};
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
  globalThis.customElements = {
    get: (name) => registry.get(name),
    define: (name, constructor) => registry.set(name, constructor),
  };
  globalThis.window = { customCards: [], addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  await import(`../dist/energy-event-explorer-card.js?smoke=${Date.now()}`);
  assert.deepEqual([...registry.keys()], [
    "energy-event-range-selector-card",
    "energy-site-history-card",
    "energy-event-explorer-card",
  ]);
  assert.equal(window.customCards.length, 3);
});
