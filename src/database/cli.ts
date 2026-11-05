import { MikroORM } from '@mikro-orm/postgresql';
import databaseConfig from './mikro-orm.config.js';

const command = process.argv[2];

if (command !== 'up' && command !== 'down') {
  console.error('use: bun src/database/cli.ts up|down');
  process.exit(1);
}

const orm = await MikroORM.init(databaseConfig);

if (command === 'up') {
  const applied = await orm.migrator.up();
  console.log(
    applied.length === 0
      ? 'schema already up to date'
      : applied.map((migration) => migration.name).join('\n'),
  );
} else {
  const reverted = await orm.migrator.down();
  console.log(
    reverted.length === 0
      ? 'nothing to revert'
      : reverted.map((migration) => migration.name).join('\n'),
  );
}

await orm.close(true);
