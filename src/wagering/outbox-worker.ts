import { MikroORM } from '@mikro-orm/postgresql';
import databaseConfig from '../database/mikro-orm.config.js';
import {
  EventPublisher,
  OutboxMessage,
  PostgresOutbox,
} from '../infrastructure/postgres-outbox.js';

const orm = await MikroORM.init(databaseConfig);

// o log leva o id do evento, não o dinheiro
const publisher: EventPublisher = {
  async publish(message: OutboxMessage) {
    console.log(
      JSON.stringify({
        level: 'info',
        message: 'outbox event published',
        eventId: message.id,
        eventType: message.eventType,
        aggregateId: message.aggregateId,
      }),
    );
  },
};

let stop = false;
const shutdown = () => {
  stop = true;
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

while (!stop) {
  const published = await new PostgresOutbox(orm.em.fork()).publishDue(
    publisher,
    20,
    new Date(),
  );
  if (published === 0) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

await orm.close();
