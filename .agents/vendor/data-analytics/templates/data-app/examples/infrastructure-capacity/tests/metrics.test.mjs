import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../fixtures/generate.mjs";
import { queueHistory } from "../content/dashboard/queue-metrics.js";

test("infrastructure-capacity fixture preserves its base measurement invariants", () => {
  const data = fixture();
  for (const row of data.queries.capacity.rows) {
    assert.ok(row.capacityUnits > 0);
    assert.ok(row.unavailableUnits >= 0 && row.unavailableUnits < row.capacityUnits);
    assert.ok(row.safeCapacityUnits <= row.capacityUnits);
  }
});

test("combined P95 uses placement frequencies instead of an average of subgroup percentiles", () => {
  const rows = [
    {timestamp:"A",queueDepth:2,p95DelaySeconds:1,delayHistogram:[[1,95],[100,5]]},
    {timestamp:"A",queueDepth:3,p95DelaySeconds:100,delayHistogram:[[100,100]]},
  ];
  assert.deepEqual(queueHistory(rows),[{timestamp:"A",queueDepth:5,p95DelaySeconds:100}]);
  assert.equal(queueHistory(rows.slice(0,1))[0].p95DelaySeconds,1);
  assert.equal(queueHistory([...rows,{timestamp:"A",queueDepth:1,p95DelaySeconds:40}])[0].p95DelaySeconds,null);
  assert.equal(queueHistory([{timestamp:"A",queueDepth:0,delayHistogram:[[1,0]]}])[0].p95DelaySeconds,null);
  assert.equal(queueHistory([{timestamp:"A",queueDepth:0,delayHistogram:[[0,10]]}])[0].p95DelaySeconds,0);
  for (const row of fixture().queries.queues.rows) assert.equal(queueHistory([row])[0].p95DelaySeconds,row.p95DelaySeconds);
});

test("incident investigation joins the same observed capacity and queue scope", () => {
  const {queries,generatedAt}=fixture();
  assert.equal(Date.parse(queries.capacity.rows.at(-1).timestamp),Date.parse(generatedAt));
  for(const incident of queries.incidents.rows) {
    assert.ok(incident.openedAt<=generatedAt);
    assert.equal(Date.parse(generatedAt)-Date.parse(incident.openedAt),incident.ageMinutes*60000);
    const scope=row=>row.region===incident.region && row.environment===incident.environment && row.pool===incident.pool && Date.parse(row.timestamp)===Date.parse(generatedAt);
    assert.equal(queries.capacity.rows.filter(scope).length,1);
    assert.equal(queries.queues.rows.filter(scope).length,1);
  }
  for(const row of queries.concentration.rows) {
    const same=other=>["timestamp","region","environment","pool"].every(key=>other[key]===row[key]);
    assert.equal(row.queueDepth,queries.queues.rows.find(same).queueDepth);
    assert.equal(row.failures,queries.failures.rows.filter(same).reduce((total,other)=>total+other.failures,0));
  }
});
