import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Post,
} from '@nestjs/common';

import { Money, InvalidMoneyError } from '../domain/money.js';
import { InvalidWalletOperationError } from '../domain/wallet.js';
import {
  OpenWallet,
  WalletAlreadyExistsError,
} from '../application/open-wallet.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('wallets')
export class WalletController {
  constructor(private readonly openWallet: OpenWallet) {}

  @Post()
  @HttpCode(201)
  async open(
    @Body()
    body: {
      playerId?: string;
      initialBalance?: { amount?: string; currency?: string };
    },
  ) {
    const amount = body?.initialBalance?.amount;
    const currency = body?.initialBalance?.currency;

    if (!body?.playerId || !uuid.test(body.playerId) || !amount || !currency) {
      throw new BadRequestException(`playerId and initialBalance are required`);
    }

    try {
      const wallet = await this.openWallet.execute({
        playerId: body.playerId,
        initialBalance: Money.from({ amount, currency }),
        openedAt: new Date(),
      });

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException(error.message);
      }

      if (
        error instanceof InvalidMoneyError ||
        error instanceof InvalidWalletOperationError
      ) {
        throw new BadRequestException(error.message);
      }

      throw error;
    }
  }
}
