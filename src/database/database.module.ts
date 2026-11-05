import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import databaseConfig from './mikro-orm.config.js';

@Module({
  imports: [MikroOrmModule.forRoot(databaseConfig)],
})
export class DatabaseModule {}
