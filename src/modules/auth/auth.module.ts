import { Module } from "@nestjs/common";
import { AnonymousProviderIdentity } from "./anonymous-provider-identity";
import { PROVIDER_IDENTITY } from "./provider-identity.port";

@Module({
  providers: [{ provide: PROVIDER_IDENTITY, useClass: AnonymousProviderIdentity }],
  exports: [PROVIDER_IDENTITY],
})
export class AuthModule {}
