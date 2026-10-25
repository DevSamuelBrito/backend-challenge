import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { parseUuid } from "../../../shared/application/parse-uuid";
import { AuthGuard } from "../../auth/auth.guard";
import { GetWagerTransaction } from "../application/get-wager-transaction";
import {
  toWagerTransactionDetailResponse,
  type WagerTransactionDetailResponse,
} from "./wager-transaction-detail.response";

@Controller()
@UseGuards(AuthGuard)
export class WagerTransactionQueryController {
  constructor(private readonly getWagerTransaction: GetWagerTransaction) {}

  @Get("wagering/transactions/:transactionId")
  async byId(
    @Param("transactionId") transactionId: string,
  ): Promise<WagerTransactionDetailResponse> {
    const transaction = await this.getWagerTransaction.byId(
      parseUuid(transactionId, "transactionId"),
    );

    return toWagerTransactionDetailResponse(transaction);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async byProvider(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<WagerTransactionDetailResponse> {
    const transaction = await this.getWagerTransaction.byProvider(
      providerId,
      externalTransactionId,
    );

    return toWagerTransactionDetailResponse(transaction);
  }
}
