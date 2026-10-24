import { InboxMessageSchema } from "../../../modules/messaging/infrastructure/inbox-message.schema";
import { OutboxMessageSchema } from "../../../modules/messaging/infrastructure/outbox-message.schema";
import { WagerTransactionSchema } from "../../../modules/wagering/infrastructure/wager-transaction.schema";
import { LedgerEntrySchema } from "../../../modules/wallet/infrastructure/ledger-entry.schema";
import { WalletSchema } from "../../../modules/wallet/infrastructure/wallet.schema";

export const ENTITY_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
