import type { HttpClient } from "../http.js";
import type { Provider, ValidationResult, ValidateCredentialInput } from "../types/providers.js";

export class ProvidersResource {
  constructor(private http: HttpClient) {}

  async list(): Promise<Provider[]> {
    const res = await this.http.get<{ providers: Provider[] }>("/providers");
    return res.providers;
  }

  async validate(providerId: string, credential: ValidateCredentialInput): Promise<ValidationResult> {
    return this.http.post<ValidationResult>(`/providers/${providerId}/validate`, credential);
  }
}
