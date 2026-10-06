import { useEffect, useMemo, useRef, useState } from "react";
import PerformanceWorker from "./performance-worker.js?worker&inline";
import { createPerformanceEngine, performanceGlobalKey, localPerformanceChanges } from "./performance-data.js";

export function usePerformanceModel(queries, filters, options) {
  const engine = useMemo(() => createPerformanceEngine(queries), [queries]);
  const key = JSON.stringify([filters,options]);
  const globalKey = performanceGlobalKey(filters,options);
  const lastGood = useRef(null);
  const client = typeof window !== "undefined" && typeof document !== "undefined";
  const [state,setState] = useState({ key: null, result: null });
  const worker = useRef(null), cache = useRef(new Map()), latest = useRef(key);
  latest.current = key;
  useEffect(() => {
    cache.current.clear();
    let instance;
    try {
      instance = new PerformanceWorker();
      instance.postMessage({ type: "init", queries });
      worker.current = instance;
    } catch { instance?.terminate(); worker.current = null; }
    return () => { instance?.terminate(); worker.current = null; };
  }, [queries]);
  useEffect(() => {
    let active = true, timer;
    const accept = data => {
      if (!active || data.key !== latest.current) return;
      if (data.result) { lastGood.current = {queries,globalKey,options,result:data.result}; cache.current.set(key,data.result); if (cache.current.size > 12) cache.current.delete(cache.current.keys().next().value); }
      setState({ ...data, queries });
    };
    const fallback = () => {
      // Paint pending UI before the synchronous fallback, never show old data under new filters.
      timer = setTimeout(() => { if (!active) return; try { accept({ key, result: engine.read(filters,options) }); }
        catch (error) { accept({ key,error:error.message }); } }, 32);
    };
    if (cache.current.has(key)) { lastGood.current = {queries,globalKey,options,result:cache.current.get(key)}; setState({ key,result:cache.current.get(key),queries }); return; }
    const instance = worker.current;
    if (instance) {
      instance.onmessage = ({data}) => accept(data);
      instance.onerror = () => { instance.terminate(); worker.current = null; fallback(); };
      instance.postMessage({ type: "read",key,filters,options });
    } else fallback();
    return () => { active = false; clearTimeout(timer); };
  }, [engine,key]);
  if (!client) return { result: engine.read(filters,options), pending:false };
  const cached = state.queries === queries && cache.current.get(key);
  const resolved = cached ?? (state.queries === queries && state.key === key ? state.result : null);
  const error = state.queries === queries && state.key === key ? state.error : null;
  const retained = lastGood.current?.queries === queries && lastGood.current.globalKey === globalKey ? lastGood.current : null;
  return { result: resolved ?? retained?.result, error, pending: !resolved && !error,
    layoutResult: lastGood.current?.queries === queries ? lastGood.current.result : null,
    localChanges: !resolved && retained ? localPerformanceChanges(retained.options,options) : [] };
}
