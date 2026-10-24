import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from "./provider-identity.port";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.identity.identify(context.switchToHttp().getRequest());

    return true;
  }
}
