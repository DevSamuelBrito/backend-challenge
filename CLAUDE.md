# CLAUDE.md

Documentos de referência (ler antes de qualquer tarefa): `docs/CHALLENGE.md` (enunciado), `docs/requirements.md` (requisitos e ambiguidades), `docs/plan.md` (plano e etapas).

## Regra de trabalho

**Implementar uma etapa do `docs/plan.md` por vez, com testes, e parar para revisão ao final de cada etapa.** Não avançar para a etapa seguinte sem aprovação. Commits direto na `main` (sem branches/PR), em português, uma mensagem por etapa (sugestão na tabela da seção 4 do plano). Só commitar/fazer push quando o usuário pedir.

## Resumo do projeto

1. Serviço financeiro distribuído (Jungle Gaming, desafio técnico de Backend) que processa transações de apostas (`BET → WIN | LOSS | REFUND | ROLLBACK`) vindas de múltiplos provedores.
2. Entrega **at-least-once**: duplicadas, fora de ordem e concorrentes; várias instâncias na mesma wallet; PostgreSQL e SQS podem cair.
3. Invariantes: sem crédito/débito duplicado, sem perder evento confirmado, sem saldo negativo; `wallet.balance == saldo reconstruído pelo ledger`.
4. Entradas: API HTTP síncrona e fila SQS (mesmo use case); saída: eventos via Transactional Outbox.
5. Avaliação (100 pts) centrada em correção financeira, concorrência, idempotência persistente, mensageria/falhas, testes com infra real; prazo de 3 dias, entrega por link do repositório.

## Stack obrigatória

| Item                                    | Escolha                                                            |
| --------------------------------------- | ------------------------------------------------------------------ |
| Runtime / package manager / test runner | **Bun 1.x**                                                        |
| Linguagem                               | **TypeScript** em modo estrito                                     |
| Framework                               | **NestJS**                                                         |
| Banco                                   | **PostgreSQL**                                                     |
| Mensageria                              | **AWS SQS** via **LocalStack** ou **MiniStack**                    |
| Orquestração local                      | **Docker Compose**                                                 |
| Migrations                              | versionadas e reversíveis                                          |
| ORM                                     | **MikroORM** (preferencial) ou TypeORM. Prisma e outros: proibidos |

## Restrições invioláveis (CHALLENGE.md §5)

1. Não usar `number`, `float` ou `double` para dinheiro.
2. Não usar cache em memória como garantia de idempotência.
3. Não confiar apenas em SQS FIFO para garantir consistência.
4. Não publicar eventos antes do commit da transação financeira.
5. Não sobrescrever nem excluir lançamentos do ledger.
6. Não usar lock global compartilhado por todas as wallets.
7. Não implementar saldo como `read → calculate → update` sem controle de concorrência.
8. A solução deve estar correta com **múltiplas instâncias** da aplicação.
9. As garantias de unicidade, imutabilidade e não-negatividade devem ser aplicadas **no schema do banco**, não apenas em código.

Falhas eliminatórias adicionais (§14): saldo negativo por race, idempotência só em memória, ausência de ledger auditável, testes que substituem PostgreSQL e SQS por mocks.

## Decisões tomadas (plan.md §0.1)

- **D1** HTTP síncrono: processa e responde com o resultado. `202` só para `PENDING_REFERENCE`.
- **D2** Outbox publica em fila SQS separada (`wager-events.fifo`), nunca em `wager-transactions.fifo`.
- **D3** Unicidade em `idempotency_key` **e** em `(provider_id, external_transaction_id)`.
- **D4** Cada transação referenciada só pode ser revertida **uma vez**, por qualquer tipo (`REFUND` ou `ROLLBACK`).
- **D5** `Money`: exatamente 2 casas decimais (sem arredondar); valor **zero rejeitado** nas operações.
- **D6** Payload malformado → `400`, não persiste. Violação de regra de negócio (saldo, moeda, referência) → persistida como `REJECTED` + `failureCode`.
- **D7** Referência existente mas inválida (outra rodada/wallet/player/moeda, tipo incompatível) → `REJECTED` com `failureCode` distinto por caso. Referência ainda `PENDING` permanece aguardando.
- **D8** Saldo resultante gravado na própria transação (replay devolve o resultado original, inclusive `LOSS`/`REJECTED`).
- **D9** Sem autenticação: documentar no `ARCHITECTURE.md` e deixar `AuthGuard` no-op como ponto de extensão.
- **D10** Concorrência: lock pessimista por wallet (`SELECT ... FOR UPDATE`) + constraints de unicidade para idempotência.

## Premissas adicionais (plan.md §0.2)

- **P1** `walletId` inexistente → `404`, não persiste (SQS: erro permanente → DLQ).
- **P2** `playerId` do payload ≠ dono da wallet → `REJECTED` `WALLET_PLAYER_MISMATCH`.
- **P3** Moeda da operação ≠ moeda da wallet → `REJECTED` `CURRENCY_MISMATCH`.
- **P4** `WIN`/`LOSS` aceitam `referenceExternalTransactionId` opcional; se informado, deve apontar para `BET` da mesma rodada/wallet/player/moeda, com as mesmas regras de pendência/rejeição.
- **P5** Referenciada em `REJECTED`/`FAILED` → `REJECTED` `REFERENCE_NOT_PROCESSED`. Referenciada em `PENDING`/`PENDING_REFERENCE` → continua `PENDING_REFERENCE`.
- **P6** `OPENING`: `provider_id = 'internal'`, `external_transaction_id = walletId`, `idempotency_key = 'opening:{walletId}'`, `round_id = game_id = 'opening'`. Emite `WagerTransactionProcessed` e `WalletBalanceChanged`.
- **P7** Replay de transação `PENDING_REFERENCE` devolve o **estado atual** (se já resolvida, o resultado final).
- **P8** `FAILED` = mensagem SQS que esgota tentativas por erro de infraestrutura e já tinha a transação identificada; registrada como `FAILED` (auditável) e vai para a DLQ.
- **P9** Mesmo `messageId` com `payloadHash` diferente no inbox → erro permanente → DLQ + métrica.
- **P10** `Idempotency-Key` ausente ou vazio → `400`.

## Convenções

- Domínio sem dependência de ORM ou decorators do NestJS; construtor `private` + factories estáticas (`create`, `from`, `rehydrate`).
- Scripts via `bun run`; lint/format com Biome (`bun run lint`, `bun run format`); tipos com `bun run typecheck`.
- Infra local: `bun run infra:up` / `bun run infra:down` (Postgres + LocalStack, filas criadas automaticamente).
