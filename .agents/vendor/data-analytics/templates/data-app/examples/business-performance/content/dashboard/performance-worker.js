import { createPerformanceEngine } from "./performance-data.js";
let engine;
self.onmessage = ({ data }) => {
  if (data.type === "init") { engine = createPerformanceEngine(data.queries); return; }
  try { self.postMessage({ key: data.key, result: engine.read(data.filters, data.options) }); }
  catch (error) { self.postMessage({ key: data.key, error: error.message }); }
};
