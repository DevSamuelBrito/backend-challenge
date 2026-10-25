import { Inject, Injectable } from "@nestjs/common";
import { InvalidRequestError } from "../../../shared/application/invalid-request-error";
import { UNIT_OF_WORK, type UnitOfWork } from "../../../shared/application/unit-of-work.port";
import type { WagerTransaction } from "../domain/wager-transaction";
import { WagerTransactionNotFoundError } from "../domain/wager-transaction-errors";

const MAX_TEXT_LENGTH = 255;

function requiredText(value: string, field: string): string {
  if (value.trim() === "" || value.length > MAX_TEXT_LENGTH) {
    throw new InvalidRequestError(
      `${field} deve ser uma string não vazia de até ${MAX_TEXT_LENGTH} caracteres`,
    );
  }

  return value;
}

@Injectable()
export class GetWagerTransaction {
  constructor(@Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.unitOfWork.run(({ transactions }) =>
      transactions.findById(transactionId),
    );

    if (!transaction) {
      throw new WagerTransactionNotFoundError(transactionId);
    }

    return transaction;
  }

  async byProvider(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const provider = requiredText(providerId, "providerId");
    const external = requiredText(externalTransactionId, "externalTransactionId");

    const transaction = await this.unitOfWork.run(({ transactions }) =>
      transactions.findByProviderAndExternalId(provider, external),
    );

    if (!transaction) {
      throw new WagerTransactionNotFoundError(`${provider}/${external}`);
    }

    return transaction;
  }
}
