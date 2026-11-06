# Wagering

Processador de apostas. O saldo e o extrato são gravados no Postgres. A mesma aposta não debita duas vezes. Duas apostas simultâneas na mesma carteira não deixam o saldo negativo.

## Subir

```bash
docker compose up -d
bun install
bun run db:migrate
```

Postgres em `localhost:5432`, banco `wagering`, usuário e senha `jungle`. LocalStack em `localhost:4566`.

## API

```bash
bun run start
```

`POST /wallets` abre a carteira. Corpo: `playerId` e `initialBalance` com `amount` e `currency`. Repetir jogador e moeda devolve 409.

`POST /wagering/transactions` exige o header `Idempotency-Key`. Processada devolve 200. Pendente de referência devolve 202. Rejeitada por regra devolve 422. A mesma chave com outro payload devolve 409. Payload inválido devolve 400. Carteira inexistente devolve 404.

`POST /wallets/:walletId/reconciliation` compara o saldo gravado com a soma do extrato. Não corrige o saldo.

## Workers

```bash
bun run worker
bun run outbox
```

O primeiro lê `wager-transactions.fifo`. O segundo publica a outbox.

## Testes

```bash
bun test
bun test ./src/infrastructure/postgres-wager-store.e2e-spec.ts
bun test ./src/wagering/sqs-consumer.e2e-spec.ts
bun test ./src/infrastructure/postgres-outbox.e2e-spec.ts
```

Os testes de integração usam Postgres e LocalStack de verdade. Não apagam carteira nem extrato: o banco recusa.