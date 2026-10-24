import { Migration } from "@mikro-orm/migrations";

export class Migration20261024153859_create_schema extends Migration {
  override name = "Migration20261024153859_create_schema";

  override up(): void | Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid not null,
        player_id text not null,
        currency char(3) not null,
        balance numeric(20,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_pkey primary key (id),
        constraint wallets_player_currency_key unique (player_id, currency),
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$')
      )
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid not null,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null,
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(20,2) not null,
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid,
        status text not null,
        failure_code text,
        balance_after_amount numeric(20,2),
        reference_attempts integer not null default 0,
        next_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_transactions_pkey primary key (id),
        constraint wager_transactions_wallet_id_fkey
          foreign key (wallet_id) references wallets (id),
        constraint wager_transactions_reference_transaction_id_fkey
          foreign key (reference_transaction_id) references wager_transactions (id),
        constraint wager_transactions_idempotency_key_key unique (idempotency_key),
        constraint wager_transactions_provider_external_key
          unique (provider_id, external_transaction_id),
        constraint wager_transactions_kind_valid
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_valid
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_amount_positive check (amount > 0),
        constraint wager_transactions_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_reversal_requires_reference
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_rejected_requires_failure_code
          check (status <> 'REJECTED' or failure_code is not null),
        constraint wager_transactions_balance_after_non_negative
          check (balance_after_amount is null or balance_after_amount >= 0),
        constraint wager_transactions_reference_attempts_non_negative
          check (reference_attempts >= 0)
      )
    `);

    this.addSql(`
      create unique index wager_transactions_single_reversal_idx
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'
    `);

    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE'
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        seq bigserial not null,
        id uuid not null,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction text not null,
        amount numeric(20,2) not null,
        currency char(3) not null,
        balance_before numeric(20,2) not null,
        balance_after numeric(20,2) not null,
        wallet_version integer not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_pkey primary key (id),
        constraint wallet_ledger_entries_seq_key unique (seq),
        constraint wallet_ledger_entries_wallet_id_fkey
          foreign key (wallet_id) references wallets (id),
        constraint wallet_ledger_entries_transaction_id_fkey
          foreign key (transaction_id) references wager_transactions (id),
        constraint wallet_ledger_entries_transaction_id_key unique (transaction_id),
        constraint wallet_ledger_entries_wallet_version_key unique (wallet_id, wallet_version),
        constraint wallet_ledger_entries_direction_valid check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallet_ledger_entries_balance_before_non_negative check (balance_before >= 0),
        constraint wallet_ledger_entries_balance_after_non_negative check (balance_after >= 0),
        constraint wallet_ledger_entries_wallet_version_positive check (wallet_version >= 1),
        constraint wallet_ledger_entries_arithmetic check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      )
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_messages_pkey primary key (consumer_name, message_id)
      )
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid not null,
        seq bigserial not null,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        published_at timestamptz,
        constraint outbox_messages_pkey primary key (id),
        constraint outbox_messages_attempts_non_negative check (attempts >= 0)
      )
    `);

    this.addSql(`
      create index outbox_messages_pending_idx
        on outbox_messages (next_attempt_at)
        where published_at is null
    `);

    this.addSql(`
      create function forbid_table_modification() returns trigger
      language plpgsql as $$
      begin
        raise exception '% é imutável: % não é permitido', tg_table_name, tg_op
          using errcode = 'integrity_constraint_violation';
      end;
      $$
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_immutable
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_table_modification()
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function forbid_table_modification()
    `);

    this.addSql(`
      create trigger wager_transactions_no_delete
        before delete on wager_transactions
        for each row execute function forbid_table_modification()
    `);

    this.addSql(`
      create trigger wager_transactions_no_truncate
        before truncate on wager_transactions
        for each statement execute function forbid_table_modification()
    `);

    this.addSql(`
      create function guard_wager_transactions_update() returns trigger
      language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager_transactions: transação % em estado terminal (%) não pode ser alterada',
            old.id, old.status
            using errcode = 'integrity_constraint_violation';
        end if;

        if new.id is distinct from old.id
          or new.provider_id is distinct from old.provider_id
          or new.external_transaction_id is distinct from old.external_transaction_id
          or new.idempotency_key is distinct from old.idempotency_key
          or new.payload_hash is distinct from old.payload_hash
          or new.wallet_id is distinct from old.wallet_id
          or new.player_id is distinct from old.player_id
          or new.round_id is distinct from old.round_id
          or new.game_id is distinct from old.game_id
          or new.kind is distinct from old.kind
          or new.amount is distinct from old.amount
          or new.currency is distinct from old.currency
          or new.reference_external_transaction_id is distinct from old.reference_external_transaction_id
          or new.created_at is distinct from old.created_at then
          raise exception 'wager_transactions: colunas de identidade e de negócio são imutáveis'
            using errcode = 'integrity_constraint_violation';
        end if;

        return new;
      end;
      $$
    `);

    this.addSql(`
      create trigger wager_transactions_guard_update
        before update on wager_transactions
        for each row execute function guard_wager_transactions_update()
    `);
  }

  override down(): void | Promise<void> {
    this.addSql("drop table outbox_messages");
    this.addSql("drop table inbox_messages");
    this.addSql("drop table wallet_ledger_entries");
    this.addSql("drop table wager_transactions");
    this.addSql("drop table wallets");
    this.addSql("drop function guard_wager_transactions_update()");
    this.addSql("drop function forbid_table_modification()");
  }
}
