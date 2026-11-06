import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';

import { Money, InvalidMoneyError } from '../domain/money.js';
import { InvalidWalletOperationError } from '../domain/wallet.js';
import {
  OpenWallet,
  WalletAlreadyExistsError,
} from '../application/open-wallet.js';
import {
  ReconcileWallet,
  WalletNotFoundError,
} from '../application/reconcile-wallet.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('wallets')
export class WalletController {
  constructor(private readonly openWallet: OpenWallet,
    private readonly reconcileWallet: ReconcileWallet,
  ) { }

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
  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string) {
    if (!walletId || !uuid.test(walletId)) {
      throw new BadRequestException('walletId must be a uuid');
    }

    try {
      const report = await this.reconcileWallet.execute(walletId);
      return {
        walletId: report.walletId,
        storedBalance: report.storedBalance.toJSON(),
        calculatedBalance: report.calculatedBalance.toJSON(),
        difference: report.difference.toJSON(),
        consistent: report.consistent,
        checkedEntries: report.checkedEntries,
      };
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException(error.message);
      }

      throw error;
    }
  }
}
