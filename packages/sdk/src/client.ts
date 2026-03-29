/**
 * KillSwitchClient — main entry point for the SDK
 *
 * Usage:
 *   const client = new KillSwitchClient({ apiKey: "ks_live_..." });
 *   const accounts = await client.accounts.list();
 */

import { HttpClient } from "./http.js";
import type { ClientOptions } from "./types/common.js";
import { AccountResource } from "./resources/account.js";
import { AccountsResource } from "./resources/accounts.js";
import { RulesResource } from "./resources/rules.js";
import { AlertsResource } from "./resources/alerts.js";
import { DatabaseResource } from "./resources/database.js";
import { AuthResource } from "./resources/auth.js";
import { BillingResource } from "./resources/billing.js";
import { TeamsResource } from "./resources/teams.js";
import { OrgsResource } from "./resources/orgs.js";
import { ActivityResource } from "./resources/activity.js";
import { AnalyticsResource } from "./resources/analytics.js";
import { MonitoringResource } from "./resources/monitoring.js";
import { ProvidersResource } from "./resources/providers.js";

const DEFAULT_BASE_URL = "https://api.kill-switch.net";

export class KillSwitchClient {
  private readonly http: HttpClient;

  private _account?: AccountResource;
  private _accounts?: AccountsResource;
  private _rules?: RulesResource;
  private _alerts?: AlertsResource;
  private _database?: DatabaseResource;
  private _auth?: AuthResource;
  private _billing?: BillingResource;
  private _teams?: TeamsResource;
  private _orgs?: OrgsResource;
  private _activity?: ActivityResource;
  private _analytics?: AnalyticsResource;
  private _monitoring?: MonitoringResource;
  private _providers?: ProvidersResource;

  constructor(options: ClientOptions = {}) {
    this.http = new HttpClient({
      baseUrl: options.baseUrl || DEFAULT_BASE_URL,
      apiKey: options.apiKey,
      jwtToken: options.jwtToken,
      orgId: options.orgId,
      timeout: options.timeout,
      maxRetries: options.maxRetries,
      fetch: options.fetch,
      hooks: options.hooks,
    });
  }

  /** Update the API key (e.g., after auth flow) */
  setApiKey(key: string): void {
    this.http.setApiKey(key);
  }

  /** Update the JWT token */
  setJwtToken(token: string): void {
    this.http.setJwtToken(token);
  }

  /** Update the org context */
  setOrgId(orgId: string): void {
    this.http.setOrgId(orgId);
  }

  /** Current authenticated account (GET/PATCH /accounts/me) */
  get account(): AccountResource {
    return (this._account ??= new AccountResource(this.http));
  }

  get accounts(): AccountsResource {
    return (this._accounts ??= new AccountsResource(this.http));
  }

  get rules(): RulesResource {
    return (this._rules ??= new RulesResource(this.http));
  }

  get alerts(): AlertsResource {
    return (this._alerts ??= new AlertsResource(this.http));
  }

  get database(): DatabaseResource {
    return (this._database ??= new DatabaseResource(this.http));
  }

  get auth(): AuthResource {
    return (this._auth ??= new AuthResource(this.http));
  }

  get billing(): BillingResource {
    return (this._billing ??= new BillingResource(this.http));
  }

  get teams(): TeamsResource {
    return (this._teams ??= new TeamsResource(this.http));
  }

  get orgs(): OrgsResource {
    return (this._orgs ??= new OrgsResource(this.http));
  }

  get activity(): ActivityResource {
    return (this._activity ??= new ActivityResource(this.http));
  }

  get analytics(): AnalyticsResource {
    return (this._analytics ??= new AnalyticsResource(this.http));
  }

  get monitoring(): MonitoringResource {
    return (this._monitoring ??= new MonitoringResource(this.http));
  }

  get providers(): ProvidersResource {
    return (this._providers ??= new ProvidersResource(this.http));
  }
}
