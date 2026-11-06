import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { WalletModule } from './wallets/wallet.module.js';
import { WageringModule } from './wagering/wagering.module.js';

@Module({
  imports: [DatabaseModule, WalletModule, WageringModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
