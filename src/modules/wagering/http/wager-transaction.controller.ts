import { Body, Controller, Headers, Post, Res, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../../auth/auth.guard";
import { ProcessWagerTransaction } from "../application/process-wager-transaction";
import { parseProcessWagerTransactionCommand } from "../application/process-wager-transaction.command";
import {
  httpStatusFor,
  toWagerTransactionResponse,
  type WagerTransactionResponse,
} from "./wager-transaction.response";

interface StatusSetter {
  status(code: number): unknown;
}

@Controller("wagering/transactions")
@UseGuards(AuthGuard)
export class WagerTransactionController {
  constructor(private readonly processWagerTransaction: ProcessWagerTransaction) {}

  @Post()
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusSetter,
  ): Promise<WagerTransactionResponse> {
    const command = parseProcessWagerTransactionCommand({ idempotencyKey, payload: body });
    const result = await this.processWagerTransaction.execute(command);

    response.status(httpStatusFor(result.status));

    return toWagerTransactionResponse(result);
  }
}
