import type { HttpClient } from "../http.js";
import type {
  Plan,
  BillingStatus,
  CheckoutInput,
  CheckoutResult,
  PortalInput,
  PortalResult,
} from "../types/billing.js";

export class BillingResource {
  constructor(private http: HttpClient) {}

  async plans(): Promise<Plan[]> {
    const res = await this.http.get<{ plans: Plan[] }>("/billing/plans");
    return res.plans;
  }

  async status(): Promise<BillingStatus> {
    return this.http.get<BillingStatus>("/billing/status");
  }

  async checkout(input: CheckoutInput): Promise<CheckoutResult> {
    return this.http.post<CheckoutResult>("/billing/checkout", input);
  }

  async portal(input?: PortalInput): Promise<PortalResult> {
    return this.http.post<PortalResult>("/billing/portal", input);
  }
}
