import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ProcessWager } from '../application/process-wager.js';
import { PostgresWagerStore } from '../infrastructure/postgres-wager-store.js';
import { WageringController } from './wagering.controller.js';

@Module({
  controllers: [WageringController],
  providers: [
    PostgresWagerStore,
    {
      provide: ProcessWager,
      useFactory: (store: PostgresWagerStore) =>
        new ProcessWager(store, { next: () => randomUUID() }),
      inject: [PostgresWagerStore],
    },
  ],
})
export class WageringModule {}
