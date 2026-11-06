import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { WalletModule } from './wallets/wallet.module.js';

@Module({
  imports: [DatabaseModule, WalletModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
