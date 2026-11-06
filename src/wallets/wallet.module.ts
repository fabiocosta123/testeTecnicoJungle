import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OpenWallet } from '../application/open-wallet.js';
import { PostgresWalletStore } from '../infrastructure/postgres-wallet-store.js';
import { WalletController } from './wallet.controller.js';
import { ReconcileWallet } from '../application/reconcile-wallet.js';
import { PostgresWalletReconciliation } from '../infrastructure/postgres-wallet-reconciliation.js';

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
    PostgresWalletReconciliation,
    {
      provide: ReconcileWallet,
      useFactory: (store: PostgresWalletReconciliation) =>
        new ReconcileWallet(store),
      inject: [PostgresWalletReconciliation],
    },
  ],
})
export class WalletModule {}
