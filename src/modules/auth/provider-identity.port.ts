export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");

export interface ProviderIdentity {
  providerId: string;
}

export interface ProviderIdentityPort {
  identify(request: unknown): Promise<ProviderIdentity>;
}
