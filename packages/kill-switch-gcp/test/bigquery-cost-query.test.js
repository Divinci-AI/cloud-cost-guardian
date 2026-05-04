const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildCostQuerySQL, queryCostBreakdown } = require("../bigquery-cost-query");

describe("buildCostQuerySQL", () => {
  const baseOpts = {
    projectId: "openai-api-4375643",
    dataset: "billing_export",
    table: "gcp_billing_export_resource_v1_01ABCD_234567_8901AB",
    windowHours: 24,
  };

  it("includes the fully-qualified backtick-quoted table reference", () => {
    const sql = buildCostQuerySQL(baseOpts);
    assert.match(
      sql,
      /`openai-api-4375643\.billing_export\.gcp_billing_export_resource_v1_01ABCD_234567_8901AB`/,
    );
  });

  it("groups + orders by service cost descending", () => {
    const sql = buildCostQuerySQL(baseOpts);
    assert.match(sql, /GROUP BY service/);
    assert.match(sql, /ORDER BY cost_usd DESC/);
  });

  it("filters BOTH _PARTITIONTIME and usage_start_time to the window", () => {
    // Filtering _PARTITIONTIME prunes scanned bytes (cost). Filtering
    // usage_start_time guarantees correctness when partitions span the boundary.
    const sql = buildCostQuerySQL({ ...baseOpts, windowHours: 24 });
    assert.match(sql, /_PARTITIONTIME >= TIMESTAMP_SUB\(CURRENT_TIMESTAMP\(\), INTERVAL 24 HOUR\)/);
    assert.match(sql, /usage_start_time >= TIMESTAMP_SUB\(CURRENT_TIMESTAMP\(\), INTERVAL 24 HOUR\)/);
  });

  it("respects the windowHours param", () => {
    const sql = buildCostQuerySQL({ ...baseOpts, windowHours: 6 });
    assert.match(sql, /INTERVAL 6 HOUR/);
  });

  it("rejects identifier params containing unsafe characters", () => {
    assert.throws(
      () => buildCostQuerySQL({ ...baseOpts, dataset: "billing-export; DROP TABLE foo --" }),
      /unsafe characters/,
    );
    assert.throws(
      () => buildCostQuerySQL({ ...baseOpts, table: "table with spaces" }),
      /unsafe characters/,
    );
    assert.throws(
      () => buildCostQuerySQL({ ...baseOpts, projectId: "proj`name" }),
      /unsafe characters/,
    );
  });

  it("rejects missing required identifier params", () => {
    assert.throws(() => buildCostQuerySQL({ ...baseOpts, projectId: "" }), /required/);
    assert.throws(() => buildCostQuerySQL({ ...baseOpts, dataset: undefined }), /required/);
    assert.throws(() => buildCostQuerySQL({ ...baseOpts, table: null }), /required/);
  });

  it("rejects non-positive windowHours", () => {
    assert.throws(() => buildCostQuerySQL({ ...baseOpts, windowHours: 0 }), /positive number/);
    assert.throws(() => buildCostQuerySQL({ ...baseOpts, windowHours: -3 }), /positive number/);
    assert.throws(() => buildCostQuerySQL({ ...baseOpts, windowHours: NaN }), /positive number/);
  });
});

describe("queryCostBreakdown", () => {
  const baseOpts = {
    projectId: "test-project",
    dataset: "billing_export",
    table: "gcp_billing_export_resource_v1_01ABCD_234567_8901AB",
    windowHours: 24,
  };

  it("aggregates total + per-service from BigQuery rows", async () => {
    const fakeRows = [
      { service: "Vertex AI", cost_usd: "120.5" },
      { service: "Cloud Run", cost_usd: 18.25 },
      { service: "Cloud Logging", cost_usd: 0.42 },
    ];
    const fakeClient = {
      query: async ({ query }) => {
        assert.match(query, /`test-project\.billing_export\./);
        return [fakeRows];
      },
    };
    const result = await queryCostBreakdown(baseOpts, { bigQueryClient: fakeClient });
    assert.equal(result.totalUSD, 139.17);
    assert.deepEqual(result.perService, [
      { service: "Vertex AI", costUSD: 120.5 },
      { service: "Cloud Run", costUSD: 18.25 },
      { service: "Cloud Logging", costUSD: 0.42 },
    ]);
  });

  it("returns zero total when BigQuery has no matching rows", async () => {
    const fakeClient = { query: async () => [[]] };
    const result = await queryCostBreakdown(baseOpts, { bigQueryClient: fakeClient });
    assert.equal(result.totalUSD, 0);
    assert.deepEqual(result.perService, []);
  });

  it("handles missing service description by labelling 'unknown'", async () => {
    const fakeClient = { query: async () => [[{ service: null, cost_usd: 5 }]] };
    const result = await queryCostBreakdown(baseOpts, { bigQueryClient: fakeClient });
    assert.equal(result.perService[0].service, "unknown");
  });

  it("coerces non-numeric cost_usd values to 0", async () => {
    const fakeClient = { query: async () => [[{ service: "Weird", cost_usd: "not-a-number" }]] };
    const result = await queryCostBreakdown(baseOpts, { bigQueryClient: fakeClient });
    assert.equal(result.totalUSD, 0);
    assert.equal(result.perService[0].costUSD, 0);
  });
});
