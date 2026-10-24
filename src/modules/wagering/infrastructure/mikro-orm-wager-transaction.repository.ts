import type { EntityManager } from "@mikro-orm/core";
import { AggregateNotFoundError } from "../../../shared/application/persistence-errors";
import { isUniqueViolation } from "../../../shared/infrastructure/database/violations";
import { WalletSchema } from "../../wallet/infrastructure/wallet.schema";
import type { WagerTransactionRepository } from "../application/wager-transaction.repository";
import {
  type DuplicatedConstraint,
  DuplicateTransactionError,
} from "../application/wagering-errors";
import type { WagerTransaction } from "../domain/wager-transaction";
import { wagerTransactionMapper } from "./wager-transaction.mapper";
import { type WagerTransactionRecord, WagerTransactionSchema } from "./wager-transaction.schema";

const DUPLICATE_CONSTRAINTS: readonly [string, DuplicatedConstraint][] = [
  ["wager_transactions_idempotency_key_key", "idempotency_key"],
  ["wager_transactions_provider_external_key", "external_transaction"],
];

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async add(transaction: WagerTransaction): Promise<void> {
    try {
      await this.em.insert(WagerTransactionSchema, wagerTransactionMapper.toRecord(transaction));
    } catch (error) {
      for (const [constraint, duplicated] of DUPLICATE_CONSTRAINTS) {
        if (isUniqueViolation(error, constraint)) {
          throw new DuplicateTransactionError(duplicated);
        }
      }

      throw error;
    }
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const { status, referenceTransactionId, failureCode, balanceAfterAmount, processedAt } =
      wagerTransactionMapper.toRecord(transaction);

    const updated = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: transaction.id },
      { status, referenceTransactionId, failureCode, balanceAfterAmount, processedAt },
    );

    if (updated === 0) {
      throw new AggregateNotFoundError("WagerTransaction", transaction.id);
    }
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.load({ id });
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.load({ idempotencyKey });
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.load({ providerId, externalTransactionId });
  }

  private async load(
    where: Partial<WagerTransactionRecord>,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, where, {
      disableIdentityMap: true,
      refresh: true,
    });

    if (!record) {
      return undefined;
    }

    const walletCurrency =
      record.balanceAfterAmount === null ? record.currency : await this.walletCurrency(record);

    return wagerTransactionMapper.toDomain(record, walletCurrency);
  }

  private async walletCurrency(record: WagerTransactionRecord): Promise<string> {
    const wallet = await this.em.findOneOrFail(
      WalletSchema,
      { id: record.walletId },
      { fields: ["currency"], disableIdentityMap: true, refresh: true },
    );

    return wallet.currency;
  }
}
