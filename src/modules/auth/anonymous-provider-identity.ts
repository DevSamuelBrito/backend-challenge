import type { ProviderIdentity, ProviderIdentityPort } from "./provider-identity.port";

export class AnonymousProviderIdentity implements ProviderIdentityPort {
  async identify(): Promise<ProviderIdentity> {
    return { providerId: "anonymous" };
  }
}
