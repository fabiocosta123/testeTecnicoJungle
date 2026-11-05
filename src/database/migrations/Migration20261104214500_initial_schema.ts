import { Migration } from '@mikro-orm/migrations';

export class Migration20261104214500_initial_schema extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency varchar(3) not null,
        balance_amount numeric(18, 2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_currency_iso check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative check (balance_amount >= 0),
        constraint wallets_version_starts_at_one check (version >= 1),
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_id_currency_unique unique (id, currency),
        constraint wallets_id_player_unique unique (id, player_id)
      )
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null,
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(18, 2) not null,
        currency varchar(3) not null,
        reference_external_transaction_id text null,
        reference_transaction_id uuid null,
        status text not null,
        failure_code text null,
        result_balance_amount numeric(18, 2) null,
        result_balance_currency varchar(3) null,
        created_at timestamptz not null,
        processed_at timestamptz null,
        constraint wager_transactions_kind check (
          kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
        ),
        constraint wager_transactions_status check (
          status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        ),
        constraint wager_transactions_amount_positive check (amount > 0),
        constraint wager_transactions_currency_iso check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_ids_not_blank check (
          length(trim(provider_id)) > 0
          and length(trim(external_transaction_id)) > 0
          and length(trim(idempotency_key)) > 0
          and length(trim(payload_hash)) > 0
          and length(trim(round_id)) > 0
          and length(trim(game_id)) > 0
        ),
        constraint wager_transactions_opening_is_internal check (
          (kind = 'OPENING' and provider_id = 'internal')
          or (kind <> 'OPENING' and provider_id <> 'internal')
        ),
        constraint wager_transactions_opening_has_no_reference check (
          kind <> 'OPENING'
          or (reference_external_transaction_id is null and reference_transaction_id is null)
        ),
        constraint wager_transactions_reversal_requires_reference check (
          kind not in ('REFUND', 'ROLLBACK')
          or (
            reference_external_transaction_id is not null
            and length(trim(reference_external_transaction_id)) > 0
          )
        ),
        constraint wager_transactions_reference_is_not_self check (
          reference_transaction_id is null or reference_transaction_id <> id
        ),
        constraint wager_transactions_failure_code_matches_status check (
          (
            status in ('REJECTED', 'FAILED')
            and failure_code is not null
            and length(trim(failure_code)) > 0
          )
          or (status not in ('REJECTED', 'FAILED') and failure_code is null)
        ),
        constraint wager_transactions_processed_at_matches_status check (
          (
            status in ('PROCESSED', 'REJECTED', 'FAILED')
            and processed_at is not null
          )
          or (
            status not in ('PROCESSED', 'REJECTED', 'FAILED')
            and processed_at is null
          )
        ),
        constraint wager_transactions_result_balance_when_processed check (
          (
            status = 'PROCESSED'
            and result_balance_amount is not null
            and result_balance_currency = currency
          )
          or (
            status <> 'PROCESSED'
            and result_balance_amount is null
            and result_balance_currency is null
          )
        ),
        constraint wager_transactions_idempotency_key_unique unique (idempotency_key),
        constraint wager_transactions_provider_external_unique unique (provider_id, external_transaction_id),
        constraint wager_transactions_wallet_currency_fk
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint wager_transactions_wallet_player_fk
          foreign key (wallet_id, player_id) references wallets (id, player_id),
        constraint wager_transactions_reference_fk
          foreign key (reference_transaction_id) references wager_transactions (id)
      )
    `);

    this.addSql(`
      create unique index wager_transactions_one_active_reversal
      on wager_transactions (provider_id, reference_external_transaction_id)
      where kind in ('REFUND', 'ROLLBACK')
        and status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED')
    `);

    this.addSql(`
      create index wager_transactions_pending_reference
      on wager_transactions (created_at, id)
      where status = 'PENDING_REFERENCE'
    `);

    this.addSql(`
      create index wager_transactions_wallet_created
      on wager_transactions (wallet_id, created_at, id)
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        currency varchar(3) not null,
        transaction_id uuid not null,
        direction text not null,
        amount numeric(18, 2) not null,
        balance_before numeric(18, 2) not null,
        balance_after numeric(18, 2) not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_direction check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_balances_non_negative check (
          balance_before >= 0 and balance_after >= 0
        ),
        constraint wallet_ledger_entries_currency_iso check (currency ~ '^[A-Z]{3}$'),
        constraint wallet_ledger_entries_arithmetic check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
        ),
        constraint wallet_ledger_entries_transaction_unique unique (transaction_id),
        constraint wallet_ledger_entries_wallet_currency_fk
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint wallet_ledger_entries_transaction_fk
          foreign key (transaction_id) references wager_transactions (id)
      )
    `);

    this.addSql(`
      create index wallet_ledger_entries_wallet_created
      on wallet_ledger_entries (wallet_id, created_at, id)
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz null,
        primary key (consumer_name, message_id),
        constraint inbox_messages_ids_not_blank check (
          length(trim(consumer_name)) > 0
          and length(trim(message_id)) > 0
          and length(trim(payload_hash)) > 0
        )
      )
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        published_at timestamptz null,
        constraint outbox_messages_attempts_non_negative check (attempts >= 0),
        constraint outbox_messages_event_type_not_blank check (length(trim(event_type)) > 0)
      )
    `);

    this.addSql(`
      create index outbox_messages_due
      on outbox_messages (next_attempt_at, occurred_at, id)
      where published_at is null
    `);

    this.addSql(`
      create function wallets_guard() returns trigger
      language plpgsql
      as $fn$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wallets cannot be deleted';
        end if;

        if tg_op = 'INSERT' then
          if new.version <> 1 then
            raise exception 'wallet version starts at 1';
          end if;
          return new;
        end if;

        if new.id is distinct from old.id
           or new.player_id is distinct from old.player_id
           or new.currency is distinct from old.currency
           or new.created_at is distinct from old.created_at
        then
          raise exception 'wallet identity columns are immutable';
        end if;

        if new.balance_amount is distinct from old.balance_amount then
          if new.version <> old.version + 1 then
            raise exception 'wallet version must increment by 1 when the balance changes';
          end if;
        elsif new.version is distinct from old.version then
          raise exception 'wallet version changes only when the balance changes';
        end if;

        return new;
      end;
      $fn$
    `);

    this.addSql(`
      create trigger wallets_guard
      before insert or update or delete on wallets
      for each row
      execute function wallets_guard()
    `);

    this.addSql(`
      create function wager_transactions_guard() returns trigger
      language plpgsql
      as $fn$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager transactions cannot be deleted';
        end if;

        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal', old.id;
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
           or new.created_at is distinct from old.created_at
        then
          raise exception 'wager transaction identity columns are immutable';
        end if;

        return new;
      end;
      $fn$
    `);

    this.addSql(`
      create trigger wager_transactions_guard
      before update or delete on wager_transactions
      for each row
      execute function wager_transactions_guard()
    `);

    this.addSql(`
      create function wallet_ledger_entries_guard() returns trigger
      language plpgsql
      as $fn$
      begin
        raise exception 'ledger entries are immutable';
      end;
      $fn$
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_guard
      before update or delete on wallet_ledger_entries
      for each row
      execute function wallet_ledger_entries_guard()
    `);

    this.addSql(`
      create function assert_wallet_matches_ledger() returns trigger
      language plpgsql
      as $fn$
      declare
        target uuid;
        stored numeric(18, 2);
        calculated numeric(18, 2);
      begin
        if tg_table_name = 'wallets' then
          target := coalesce(new.id, old.id);
        else
          target := coalesce(new.wallet_id, old.wallet_id);
        end if;

        select balance_amount into stored from wallets where id = target;

        if stored is null then
          raise exception 'wallet % not found while checking the ledger', target;
        end if;

        select coalesce(sum(
          case direction
            when 'CREDIT' then amount
            when 'DEBIT' then -amount
          end
        ), 0)::numeric(18, 2)
        into calculated
        from wallet_ledger_entries
        where wallet_id = target;

        if stored is distinct from calculated then
          raise exception 'wallet % balance % does not match ledger %', target, stored, calculated;
        end if;

        return null;
      end;
      $fn$
    `);

    this.addSql(`
      create constraint trigger wallets_match_ledger
      after insert or update of balance_amount on wallets
      deferrable initially deferred
      for each row
      execute function assert_wallet_matches_ledger()
    `);

    this.addSql(`
      create constraint trigger wallet_ledger_entries_match_wallet
      after insert or update or delete on wallet_ledger_entries
      deferrable initially deferred
      for each row
      execute function assert_wallet_matches_ledger()
    `);
  }

  override down(): void {
    this.addSql('drop table if exists outbox_messages');
    this.addSql('drop table if exists inbox_messages');
    this.addSql('drop table if exists wallet_ledger_entries');
    this.addSql('drop table if exists wager_transactions');
    this.addSql('drop table if exists wallets');
    this.addSql('drop function if exists assert_wallet_matches_ledger()');
    this.addSql('drop function if exists wallet_ledger_entries_guard()');
    this.addSql('drop function if exists wager_transactions_guard()');
    this.addSql('drop function if exists wallets_guard()');
  }
}
