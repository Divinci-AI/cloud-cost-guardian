const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// We test the handler in isolation by stubbing the BigQuery and PubSub clients
// at require-time. The handler reads env vars at call-time of the exported
// function (well, mostly — see "module-scope env" note below), so we set them
// before requiring `daily-rate.js`.

const ORIGINAL_ENV = { ...process.env };

function loadFreshHandler({ env, bqRows = [], publishedMessages = null }) {
  // Reset env
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("DAILY_RATE_") || k.startsWith("BILLING_") || k === "GCP_PROJECT_ID") {
      delete process.env[k];
    }
  }
  Object.assign(process.env, env);

  // Inject fake @google-cloud/bigquery + @google-cloud/pubsub via require cache
  const bqModule = require.resolve("@google-cloud/bigquery");
  const pubsubModule = require.resolve("@google-cloud/pubsub");

  require.cache[bqModule] = {
    id: bqModule,
    filename: bqModule,
    loaded: true,
    exports: {
      BigQuery: class FakeBigQuery {
        async query() { return [bqRows]; }
      },
    },
  };
  require.cache[pubsubModule] = {
    id: pubsubModule,
    filename: pubsubModule,
    loaded: true,
    exports: {
      PubSub: class FakePubSub {
        topic() {
          return {
            publishMessage: async ({ data }) => {
              if (publishedMessages) publishedMessages.push(JSON.parse(data.toString()));
              return "fake-message-id-123";
            },
          };
        }
      },
    },
  };

  // Drop the daily-rate + bigquery-cost-query modules from cache so they re-init
  // with the new env + injected stubs.
  for (const key of Object.keys(require.cache)) {
    if (key.includes("daily-rate.js") || key.includes("bigquery-cost-query.js")) {
      delete require.cache[key];
    }
  }
  return require("../daily-rate").dailyRateWatcher;
}

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

afterEach(() => {
  // Restore env after each test
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("dailyRateWatcher", () => {
  it("returns config-error when required env is missing", async () => {
    const handler = loadFreshHandler({
      env: {}, // intentionally missing GCP_PROJECT_ID + dataset/table
    });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "config-error");
    assert.match(res.body.message, /missing required env/);
  });

  it("returns ok with no breach when total under threshold", async () => {
    const handler = loadFreshHandler({
      env: {
        GCP_PROJECT_ID: "openai-api-4375643",
        BILLING_EXPORT_DATASET: "billing_export",
        BILLING_EXPORT_TABLE: "gcp_billing_export_resource_v1_01ABCD_234567_8901AB",
        DAILY_RATE_THRESHOLD_USD: "100",
      },
      bqRows: [{ service: "Cloud Run", cost_usd: 25.5 }],
    });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "ok");
    assert.equal(res.body.breached, false);
    assert.equal(res.body.totalUSD, 25.5);
    assert.equal(res.body.thresholdUSD, 100);
  });

  it("publishes to Pub/Sub when total exceeds threshold", async () => {
    const published = [];
    const handler = loadFreshHandler({
      env: {
        GCP_PROJECT_ID: "openai-api-4375643",
        BILLING_EXPORT_DATASET: "billing_export",
        BILLING_EXPORT_TABLE: "gcp_billing_export_resource_v1_01ABCD_234567_8901AB",
        DAILY_RATE_THRESHOLD_USD: "50",
        BILLING_ALERTS_TOPIC: "billing-alerts",
      },
      bqRows: [
        { service: "Vertex AI", cost_usd: 200 },
        { service: "Cloud Run", cost_usd: 12 },
      ],
      publishedMessages: published,
    });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "breach-published");
    assert.equal(res.body.messageId, "fake-message-id-123");
    assert.equal(published.length, 1);
    // Payload must look like a budget-overrun event so the existing Pub/Sub
    // handler treats it the same way.
    assert.equal(published[0].costAmount, 212);
    assert.equal(published[0].budgetAmount, 50);
    assert.equal(published[0].source, "daily-rate-watcher");
    assert.equal(published[0].currencyCode, "USD");
    assert.ok(Array.isArray(published[0].perService));
    assert.ok(typeof published[0].detectedAt === "string");
  });

  it("respects DAILY_RATE_DRY_RUN — does NOT publish on breach", async () => {
    const published = [];
    const handler = loadFreshHandler({
      env: {
        GCP_PROJECT_ID: "openai-api-4375643",
        BILLING_EXPORT_DATASET: "billing_export",
        BILLING_EXPORT_TABLE: "gcp_billing_export_resource_v1_01ABCD_234567_8901AB",
        DAILY_RATE_THRESHOLD_USD: "50",
        DAILY_RATE_DRY_RUN: "true",
      },
      bqRows: [{ service: "Vertex AI", cost_usd: 200 }],
      publishedMessages: published,
    });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.body.status, "dry-run-breach");
    assert.equal(published.length, 0);
  });

  it("treats threshold equality as breach (>=, not >)", async () => {
    const published = [];
    const handler = loadFreshHandler({
      env: {
        GCP_PROJECT_ID: "test",
        BILLING_EXPORT_DATASET: "billing_export",
        BILLING_EXPORT_TABLE: "gcp_billing_export_resource_v1_01ABCD_234567_8901AB",
        DAILY_RATE_THRESHOLD_USD: "100",
      },
      bqRows: [{ service: "Cloud Run", cost_usd: 100 }],
      publishedMessages: published,
    });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.body.status, "breach-published");
    assert.equal(published.length, 1);
  });
});
