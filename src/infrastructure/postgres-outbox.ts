import { EntityManager } from '@mikro-orm/postgresql';

export interface OutboxMessage {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date;
  attempts: number;
}

export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
}

export class PostgresOutbox {
  constructor(private readonly em: EntityManager) {}

  async publishDue(
    publisher: EventPublisher,
    limit: number,
    now: Date,
  ): Promise<number> {
    return this.em.transactional(
      async (tx) => {
        // skip locked: dois publishers não carregam a mesma linha
        const rows = await tx.execute<OutboxRow[]>(
          `select id, aggregate_id, event_type, payload, occurred_at, attempts
         from outbox_messages
         where published_at is null
           and next_attempt_at <= ?
         order by next_attempt_at, occurred_at, id
         limit ?
         for update skip locked`,
          [now, limit],
          'all',
        );

        let published = 0;
        for (const row of rows) {
          const message = toMessage(row);
          try {
            await publisher.publish(message);
          } catch {
            await tx.execute(
              `update outbox_messages
             set attempts = attempts + 1, next_attempt_at = ?
             where id = ?`,
              [
                new Date(now.getTime() + retryDelayMs(row.attempts + 1)),
                row.id,
              ],
              'run',
            );
            continue;
          }

          // só marca publicada depois que a publicação voltou sem erro
          await tx.execute(
            `update outbox_messages set published_at = ? where id = ?`,
            [now, row.id],
            'run',
          );
          published += 1;
        }

        return published;
      },
      { clear: true },
    );
  }
}

function toMessage(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
  };
}

function retryDelayMs(nextAttempt: number): number {
  return Math.min(1000 * 2 ** (nextAttempt - 1), 60_000);
}
