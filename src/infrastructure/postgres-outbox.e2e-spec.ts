import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import databaseConfig from '../database/mikro-orm.config.js';
import { EventPublisher, PostgresOutbox } from './postgres-outbox.js';

// data anterior às outras suítes: o publicador só enxerga as linhas deste teste
const at = new Date('1999-01-01T00:00:00.000Z');

describe('PostgresOutbox', () => {
  let orm: MikroORM;
  let em: EntityManager;

  beforeAll(async () => {
    orm = await MikroORM.init(databaseConfig);
    em = orm.em.fork();
  });

  afterAll(async () => {
    await orm.close();
  });

  it('lets two publishers deliver each pending event once', async () => {
    const first = await insertEvent('WagerTransactionProcessed');
    const second = await insertEvent('WalletBalanceChanged');
    const left = new MemoryPublisher();
    const right = new MemoryPublisher();

    // segura a trava um instante para os dois publishers se encontrarem
    const [leftCount, rightCount] = await Promise.all([
      new PostgresOutbox(em.fork()).publishDue(left.delayed(), 10, at),
      new PostgresOutbox(em.fork()).publishDue(right.delayed(), 10, at),
    ]);
    const ids = [...left.ids, ...right.ids];

    expect(leftCount + rightCount).toBe(2);
    expect(ids.sort()).toEqual([first, second].sort());
    expect(new Set(ids).size).toBe(2);
    expect(await pendingCount([first, second])).toBe('0');
  });

  it('keeps the event pending when publishing fails', async () => {
    const id = await insertEvent('WagerTransactionRejected');
    const broken: EventPublisher = {
      async publish() {
        throw new Error('downstream is down');
      },
    };

    const published = await new PostgresOutbox(em.fork()).publishDue(
      broken,
      10,
      at,
    );
    const row = await read(id);
    const later = new Date(at.getTime() + 60_000);
    const recovered = new MemoryPublisher();
    const second = await new PostgresOutbox(em.fork()).publishDue(
      recovered,
      10,
      later,
    );

    expect(published).toBe(0);
    expect(row.attempts).toBe(1);
    expect(row.published_at).toBeNull();
    expect(second).toBe(1);
    expect(recovered.ids).toEqual([id]);
    expect(await pendingCount([id])).toBe('0');
  });

  async function insertEvent(eventType: string): Promise<string> {
    const id = randomUUID();
    await em.execute(
      `insert into outbox_messages (
         id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at
       ) values (?, ?, ?, ?::jsonb, ?, 0, ?)`,
      [
        id,
        randomUUID(),
        eventType,
        JSON.stringify({ eventId: id, eventType }),
        at,
        at,
      ],
      'run',
    );
    return id;
  }

  async function read(id: string) {
    const rows = await em.execute<
      Array<{ attempts: number; published_at: Date | null }>
    >(
      `select attempts, published_at from outbox_messages where id = ?`,
      [id],
      'all',
    );
    return rows[0];
  }

  async function pendingCount(ids: string[]): Promise<string> {
    const rows = await em.execute<Array<{ total: string }>>(
      `select count(*)::text as total from outbox_messages
       where id in (${ids.map(() => '?').join(', ')})
         and published_at is null`,
      ids,
      'all',
    );
    return rows[0].total;
  }
});

class MemoryPublisher implements EventPublisher {
  readonly ids: string[] = [];

  async publish(message: { id: string }): Promise<void> {
    this.ids.push(message.id);
  }

  delayed(): EventPublisher {
    return {
      publish: async (message) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        this.ids.push(message.id);
      },
    };
  }
}
