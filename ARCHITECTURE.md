
# Arquitetura

## Dinheiro

`Money` usa `decimal.js` e só aceita string com duas casas. O Postgres guarda `numeric(18, 2)`. Não existe `number` no saldo.

## Carteira e extrato

Cada mudança de saldo grava a carteira e uma linha de extrato na mesma transação. `LOSS` e rejeição não geram linha. A versão sobe só quando o saldo muda. Abertura com valor positivo nasce na versão 1, com um crédito vindo de zero. O provedor dessa abertura é `internal`.

## Concorrência

A unidade é a carteira. Dentro da transação, `select ... from wallets where id = ? for update`. Duas apostas da mesma carteira não debitam juntas. O cenário obrigatório está testado: saldo 100,00, duas apostas de 80,00, uma processada, uma rejeitada, saldo final 20,00, um débito.

## Idempotência

A chave fica em constraint única. O hash é SHA-256 do JSON dos campos de negócio, com as chaves em ordem alfabética. A mesma chave e o mesmo payload devolvem a resposta original. A mesma chave com outro payload é conflito, não replay. A aposta repetida 50 vezes deixa um débito.

## Reversão

`REFUND` e `ROLLBACK` exigem o id externo da transação original, já processada, do mesmo provedor, jogador, carteira, moeda, rodada e valor. Há no máximo uma reversão ativa por referência, seja refund ou rollback. Refund sempre credita. A checagem da aposta fica em `assertCompatibleReference`, não na direção do lançamento. Rollback de um débito que deixaria o saldo negativo usa `REVERSAL_WOULD_GO_NEGATIVE`.

## Fila

A inbox entra no mesmo commit da aposta, pela chave `(consumer_name, message_id)`. O delete na fila só ocorre depois desse commit. Erro de negócio confirma a mensagem. Falha transitória devolve com espera maior. Na quinta tentativa, ou com payload inválido, a mensagem vai para `wager-transactions-dlq.fifo`. `SIGINT` e `SIGTERM` terminam a mensagem já recebida e param de buscar outra.

## Outbox

O evento nasce na mesma transação da aposta. O publicador lê com `for update skip locked` e só grava `published_at` depois da publicação. Se o processo morre antes, a linha continua pendente. O destino desta entrega é o log, com o id do evento, sem o valor em dinheiro. Uma publicação repetida carrega o mesmo id.

## Reconciliação

A diferença é o saldo gravado menos a soma do extrato. Divergência é logada e contada em `divergenceCount`. O saldo não é alterado.

## Autenticação

Não foi implementada. Os health checks ficariam abertos. A fila seria um canal interno, e o `providerId` da mensagem continuaria validado no domínio. O ponto de extensão é um guard na frente dos controllers, sem entrar no caso de uso.

## Limitações

Não há `GET` de carteira, extrato ou transação. Não há `/health/live` nem `/health/ready`. Não há métricas além do contador de divergência. O refund que chega antes da aposta fica `PENDING_REFERENCE` e não é reprocessado quando a aposta aparece. Não há teste de carga.