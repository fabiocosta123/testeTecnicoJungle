import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OpenWallet } from '../application/open-wallet.js';
import { PostgresWalletStore } from '../infrastructure/postgres-wallet-store.js';
import { WalletController } from './wallet.controller.js';

@Module({
  controllers: [WalletController],
  providers: [
    PostgresWalletStore,
    {
      provide: OpenWallet,
      useFactory: (store: PostgresWalletStore) =>
        new OpenWallet(store, { next: () => randomUUID() }),
      inject: [PostgresWalletStore],
    },
  ],
})
export class WalletModule {}
