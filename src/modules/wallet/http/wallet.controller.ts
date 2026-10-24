import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { parseUuid } from "../../../shared/application/parse-uuid";
import { AuthGuard } from "../../auth/auth.guard";
import { GetWallet } from "../application/get-wallet";
import { OpenWallet } from "../application/open-wallet";
import { parseOpenWalletRequest } from "./open-wallet.request";
import { toWalletResponse, type WalletResponse } from "./wallet.response";

@Controller("wallets")
@UseGuards(AuthGuard)
export class WalletController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly getWallet: GetWallet,
  ) {}

  @Post()
  @HttpCode(201)
  async open(@Body() body: unknown): Promise<WalletResponse> {
    const wallet = await this.openWallet.execute(parseOpenWalletRequest(body));

    return toWalletResponse(wallet);
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string): Promise<WalletResponse> {
    const wallet = await this.getWallet.execute(parseUuid(walletId, "walletId"));

    return toWalletResponse(wallet);
  }
}
