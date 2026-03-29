/**
 * OpenAPI Specification for Kill Switch API
 */

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Kill Switch API",
    version: "0.1.0",
    description: "Monitor cloud spending, auto-kill runaway services, and protect your infrastructure. Born from a $91K Cloudflare bill.",
    contact: { name: "Divinci AI", url: "https://divinci.ai", email: "support@divinci.ai" },
    license: { name: "MIT", url: "https://opensource.org/licenses/MIT" },
  },
  servers: [
    { url: "https://guardian-api-150038457816.us-central1.run.app", description: "Staging" },
    { url: "http://localhost:8090", description: "Local Development" },
  ],
  tags: [
    { name: "Cloud Accounts", description: "Connect and manage cloud provider accounts" },
    { name: "Monitoring", description: "Usage checks and monitoring engine" },
    { name: "Alerts", description: "Alert channels and delivery" },
    { name: "Rules", description: "Programmable kill switch rules" },
    { name: "Database", description: "Database kill switch sequences" },
    { name: "Billing", description: "Stripe subscription management" },
    { name: "Providers", description: "Supported cloud provider info" },
  ],
  paths: {
    "/": {
      get: { summary: "Health check", operationId: "healthCheck", tags: ["Monitoring"],
        responses: { "200": { description: "Service status and available endpoints" } } },
    },
    "/providers": {
      get: { summary: "List supported providers", operationId: "listProviders", tags: ["Providers"],
        responses: { "200": { description: "Available providers with default thresholds" } } },
    },
    "/providers/{providerId}/validate": {
      post: { summary: "Validate cloud credentials", operationId: "validateCredential", tags: ["Providers"],
        parameters: [{ name: "providerId", in: "path", required: true, schema: { type: "string", enum: ["cloudflare", "gcp"] } }],
        requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/Credential" } } } },
        responses: { "200": { description: "Validation result" } } },
    },
    "/cloud-accounts": {
      get: { summary: "List connected cloud accounts", operationId: "listCloudAccounts", tags: ["Cloud Accounts"], security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Connected accounts" } } },
      post: { summary: "Connect a cloud provider", operationId: "connectCloudAccount", tags: ["Cloud Accounts"], security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object", required: ["provider", "name", "credential"],
          properties: {
            provider: { type: "string", enum: ["cloudflare", "gcp"] },
            name: { type: "string", example: "Production Cloudflare" },
            credential: { "$ref": "#/components/schemas/Credential" },
          },
        } } } },
        responses: { "201": { description: "Account connected" }, "400": { description: "Invalid credentials" }, "403": { description: "Tier limit exceeded" } } },
    },
    "/cloud-accounts/{id}": {
      get: { summary: "Get cloud account details", operationId: "getCloudAccount", tags: ["Cloud Accounts"], security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Account details with last check status" } } },
      put: { summary: "Update thresholds and settings", operationId: "updateCloudAccount", tags: ["Cloud Accounts"], security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { "$ref": "#/components/schemas/ThresholdUpdate" } } } },
        responses: { "200": { description: "Updated account" } } },
      delete: { summary: "Disconnect and delete credentials", operationId: "deleteCloudAccount", tags: ["Cloud Accounts"], security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Account disconnected" } } },
    },
    "/cloud-accounts/{id}/check": {
      post: { summary: "Run manual check on account", operationId: "checkCloudAccount", tags: ["Monitoring"], security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Check result with violations and actions" } } },
    },
    "/cloud-accounts/{id}/usage": {
      get: { summary: "Get usage history", operationId: "getUsageHistory", tags: ["Monitoring"], security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "days", in: "query", schema: { type: "integer", default: 7 } },
        ],
        responses: { "200": { description: "Time-series usage data" } } },
    },
    "/check": {
      post: { summary: "Run monitoring check on all accounts", operationId: "runCheck", tags: ["Monitoring"],
        responses: { "200": { description: "Check results for all accounts" } } },
    },
    "/alerts/channels": {
      get: { summary: "List alert channels", operationId: "listAlertChannels", tags: ["Alerts"], security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Configured alert channels" } } },
      put: { summary: "Update alert channels", operationId: "updateAlertChannels", tags: ["Alerts"], security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { channels: { type: "array", items: { "$ref": "#/components/schemas/AlertChannel" } } } } } } },
        responses: { "200": { description: "Channels updated" } } },
    },
    "/alerts/test": {
      post: { summary: "Test alert delivery", operationId: "testAlerts", tags: ["Alerts"], security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Test alert sent" } } },
    },
    "/rules": {
      get: { summary: "List kill switch rules", operationId: "listRules", tags: ["Rules"], security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Active rules" } } },
      post: { summary: "Create custom rule", operationId: "createRule", tags: ["Rules"], security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/KillSwitchRule" } } } },
        responses: { "201": { description: "Rule created" } } },
    },
    "/rules/presets": {
      get: { summary: "List preset rule templates", operationId: "listPresets", tags: ["Rules"],
        responses: { "200": { description: "Available security presets (DDoS, brute force, cost runaway, etc.)" } } },
    },
    "/rules/presets/{presetId}": {
      post: { summary: "Apply a preset rule", operationId: "applyPreset", tags: ["Rules"], security: [{ bearerAuth: [] }],
        parameters: [{ name: "presetId", in: "path", required: true, schema: { type: "string", enum: ["ddos", "brute-force", "cost-runaway", "error-storm", "exfiltration"] } }],
        responses: { "201": { description: "Preset rule applied" } } },
    },
    "/rules/agent/trigger": {
      post: { summary: "Agent-triggered kill switch", operationId: "agentTrigger", tags: ["Rules"], security: [{ bearerAuth: [] }],
        description: "Called by an AI security agent that detected an anomaly. Creates a rule and optionally auto-executes.",
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object", required: ["threatDescription", "recommendedActions"],
          properties: {
            agentId: { type: "string" },
            threatDescription: { type: "string", example: "Unusual egress pattern detected on worker-api" },
            severity: { type: "string", enum: ["info", "warning", "critical"] },
            recommendedActions: { type: "array", items: { type: "object", properties: { type: { type: "string" }, target: { type: "string" } } } },
            autoExecute: { type: "boolean", default: false },
          },
        } } } },
        responses: { "201": { description: "Rule created (pending approval or executing)" } } },
    },
    "/database/kill": {
      post: { summary: "Initiate database kill sequence", operationId: "initiateKill", tags: ["Database"], security: [{ bearerAuth: [] }],
        description: "Starts a snapshot-verify-isolate-nuke sequence. Each step must be advanced manually.",
        responses: { "201": { description: "Kill sequence initiated" } } },
      get: { summary: "List active kill sequences", operationId: "listKillSequences", tags: ["Database"], security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Active sequences" } } },
    },
    "/database/kill/{id}/advance": {
      post: { summary: "Advance kill sequence to next step", operationId: "advanceKill", tags: ["Database"], security: [{ bearerAuth: [] }],
        description: "Executes the next step. Nuke requires humanApproval: true and a verified snapshot.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Updated sequence state" } } },
    },
    "/billing/plans": {
      get: { summary: "List subscription plans", operationId: "listPlans", tags: ["Billing"],
        responses: { "200": { description: "Available plans with pricing" } } },
    },
    "/billing/checkout": {
      post: { summary: "Create Stripe checkout session", operationId: "createCheckout", tags: ["Billing"], security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { planKey: { type: "string", example: "guardian_pro_monthly" } } } } } },
        responses: { "200": { description: "Checkout URL" } } },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Clerk JWT token or ks_live_ API key" },
    },
    schemas: {
      Credential: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["cloudflare", "gcp"] },
          apiToken: { type: "string", description: "Cloudflare API token" },
          accountId: { type: "string", description: "Cloudflare Account ID" },
          serviceAccountJson: { type: "string", description: "GCP Service Account JSON" },
          projectId: { type: "string", description: "GCP Project ID" },
        },
      },
      ThresholdUpdate: {
        type: "object",
        properties: {
          thresholds: { type: "object", properties: {
            doRequestsPerDay: { type: "number" }, doWalltimeHoursPerDay: { type: "number" },
            workerRequestsPerDay: { type: "number" }, monthlySpendLimitUSD: { type: "number" },
          } },
          protectedServices: { type: "array", items: { type: "string" } },
          autoDisconnect: { type: "boolean" },
        },
      },
      AlertChannel: {
        type: "object", required: ["type", "name", "config", "enabled"],
        properties: {
          type: { type: "string", enum: ["pagerduty", "discord", "slack", "email", "webhook"] },
          name: { type: "string" }, config: { type: "object" }, enabled: { type: "boolean" },
        },
      },
      KillSwitchRule: {
        type: "object",
        properties: {
          id: { type: "string" }, name: { type: "string" }, enabled: { type: "boolean" },
          trigger: { type: "string", enum: ["cost", "security", "custom", "api", "agent"] },
          conditions: { type: "array", items: { type: "object" } },
          actions: { type: "array", items: { type: "object" } },
          cooldownMinutes: { type: "number" },
        },
      },
    },
  },
};
