import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWager } from '../application/process-wager.js';
import databaseConfig from '../database/mikro-orm.config.js';
import { PostgresWagerStore } from '../infrastructure/postgres-wager-store.js';
import {
  createSqsClient,
  ensureQueues,
  handleDelivery,
  receiveOne,
  settleDelivery,
} from './sqs.js';

const orm = await MikroORM.init(databaseConfig);
const client = createSqsClient();
const queues = await ensureQueues(client);

let stop = false;
// o sinal encerra o ciclo; a mensagem já recebida termina antes do processo sair
const shutdown = () => {
  stop = true;
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

while (!stop) {
  const message = await receiveOne(client, queues.wagerUrl, 20);
  if (!message?.Body) {
    continue;
  }

  const em = orm.em.fork();
  const processWager = new ProcessWager(new PostgresWagerStore(em), {
    next: () => randomUUID(),
  });
  const receiveCount = Number(
    message.Attributes?.ApproximateReceiveCount ?? '1',
  );
  const outcome = await handleDelivery({
    processWager,
    body: message.Body,
    receiveCount,
  });
  await settleDelivery(client, queues, message, outcome);
  console.log(
    JSON.stringify({
      level: outcome === 'retry' ? 'warn' : 'info',
      message: 'wager message settled',
      messageId: message.MessageId,
      outcome,
      receiveCount,
    }),
  );
}

await orm.close();
client.destroy();
