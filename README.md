# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de vários provedores, por **API HTTP** e por **fila SQS**, mantendo o saldo de cada carteira (wallet) consistente com um **ledger imutável**.

A entrega é *at-least-once*: a mesma transação chega duplicada, fora de ordem e em paralelo, por várias instâncias da aplicação, e o PostgreSQL ou o SQS podem cair. O projeto garante, **no banco de dados**, que não há débito ou crédito duplicado, que o saldo nunca fica negativo e que `wallet.balance` sempre bate com o saldo reconstruído pelo ledger. Eventos de saída são publicados por *Transactional Outbox*.

Stack: Bun, TypeScript (strict), NestJS, MikroORM, PostgreSQL, AWS SQS (LocalStack) e Docker Compose. Decisões, trade-offs e limitações: [ARCHITECTURE.md](ARCHITECTURE.md). Enunciado original: [docs/CHALLENGE.md](docs/CHALLENGE.md).

## Requisitos

| Para | Preciso de |
|---|---|
| Rodar a aplicação | Docker com Compose v2.24 ou superior (testado com Docker 29 e Compose 5.5). Nada mais. |
| Rodar os testes e os scripts de verificação | [Bun](https://bun.sh) 1.4.x (a imagem usa a 1.4.4) e `bun install` |

## Início rápido

```bash
docker compose up --build
```

Esse único comando constrói a imagem, sobe PostgreSQL e LocalStack (que cria as 3 filas), roda as migrations **uma vez** (serviço `migrate`) e só então inicia a aplicação. Na primeira vez leva alguns minutos (download das imagens); depois, segundos.

Para rodar em segundo plano, acrescente `-d` (e `--wait` para esperar a aplicação ficar saudável). Descubra em que porta a aplicação ficou e verifique que subiu (em outro terminal):

```bash
docker compose port app 3000        # 0.0.0.0:3000 (ou outra porta da faixa, ver abaixo)
API=http://localhost:$(docker compose port app 3000 | sed 's/.*://')
curl -i $API/health/ready
# HTTP/1.1 200 OK
# {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
```

```powershell
$api = "http://localhost:" + (docker compose port app 3000).Split(":")[-1]
curl.exe -i "$api/health/ready"
```

> **A porta nem sempre é a 3000.** O `app` publica a faixa `3000-3009` (para permitir várias instâncias) e o Docker distribui as portas da faixa em rodízio: na primeira subida costuma ser a `3000`, mas depois de recriar os containers pode ser a `3003`, por exemplo. Por isso os exemplos usam `$API` (bash) e `$api` (PowerShell), obtidos como acima.

### Várias instâncias

```bash
docker compose up --build --scale app=3
```

Cada instância publica a porta 3000 do container em **uma porta livre da faixa `3000-3009`** do computador (a variável `APP_PORTS` muda a faixa). Descubra quais portas foram atribuídas:

```bash
docker compose ps
docker compose port --index 2 app 3000      # porta da instância 2
```

A faixa limita a 10 instâncias no mesmo computador. Não há balanceador na frente: cada instância é acessada diretamente pela sua porta, de propósito, para ser possível provar que várias instâncias concorrem na mesma wallet. A verificação automática está em [Testes](#testes) (`bun run smoke:scale`).

### Parar e limpar

```bash
docker compose stop          # encerramento gracioso, mantém o banco
docker compose down -v       # remove containers E o volume do banco
```

### Portas padrão

| Serviço | Porta no computador | Variável |
|---|---|---|
| Aplicação (por instância) | uma porta da faixa `3000-3009` (ver acima) | `APP_PORTS` |
| PostgreSQL | `5432` | `POSTGRES_PORT` |
| LocalStack (SQS) | `4566` | `LOCALSTACK_PORT` |

Os exemplos abaixo usam `$API` (bash) e `$api` (PowerShell), definidos no início rápido. Com várias instâncias, `docker compose port --index N app 3000` devolve a porta da instância `N`; use-a no lugar para falar com uma instância específica.

## Exemplos de uso

Os exemplos de bash usam `curl`. Os de PowerShell usam `curl.exe` (o `curl` do PowerShell 5 é outro comando) e enviam o JSON pelo *pipe* (`-d "@-"`), porque o PowerShell 5 remove as aspas de argumentos para programas nativos. No PowerShell 7 também funciona. Os `id`s abaixo são ilustrativos.

> Dinheiro é sempre **string com exatamente 2 casas decimais** (`"10.00"`), nunca número JSON.

### 1. Criar uma wallet

```bash
curl -s -X POST $API/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

```powershell
'{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}' |
  curl.exe -s -X POST $api/wallets -H "content-type: application/json" -d "@-"
```

Resposta `201`:

```json
{"id":"01a17376-ec6f-767a-82d3-020218f778ca","playerId":"player-1","balance":{"amount":"100.00","currency":"BRL"},"version":1}
```

Guarde o `id` (`WALLET_ID` abaixo). Uma segunda wallet do mesmo jogador na mesma moeda responde `409 WALLET_ALREADY_EXISTS`.

### 2. Enviar uma BET

O header `Idempotency-Key` é obrigatório. `(providerId, externalTransactionId)` identifica a transação no provedor.

```bash
WALLET_ID=01a17376-ec6f-767a-82d3-020218f778ca

curl -s -w '\n[HTTP %{http_code}]\n' -X POST $API/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:bet-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"player-1",
       "walletId":"'$WALLET_ID'","roundId":"round-1","gameId":"game-1","kind":"BET",
       "money":{"amount":"30.00","currency":"BRL"}}'
```

```powershell
$walletId = "01a17376-ec6f-767a-82d3-020218f778ca"
@"
{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"player-1",
 "walletId":"$walletId","roundId":"round-1","gameId":"game-1","kind":"BET",
 "money":{"amount":"30.00","currency":"BRL"}}
"@ | curl.exe -s -w "`n[HTTP %{http_code}]`n" -X POST $api/wagering/transactions `
  -H "content-type: application/json" -H "Idempotency-Key: provider-a:bet-1" -d "@-"
```

`200`:

```json
{"transactionId":"01a17376-ecc2-74b8-8012-807a18320652","status":"PROCESSED","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":false}
```

### 3. Repetir a mesma BET (replay)

Mesmo comando, mesma `Idempotency-Key`, mesmo corpo: nada é debitado de novo e o resultado original volta, com `idempotentReplay: true`.

```json
{"transactionId":"01a17376-ecc2-74b8-8012-807a18320652","status":"PROCESSED","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":true}
```

Mesma `Idempotency-Key` com **corpo diferente** (por exemplo `"amount":"31.00"`) responde `409`:

```json
{"code":"IDEMPOTENCY_CONFLICT","message":"A Idempotency-Key provider-a:bet-1 já foi usada com um payload diferente"}
```

### 4. Uma aposta rejeitada por saldo (422)

Uma BET de `500.00` sobre o saldo de `70.00` é **persistida como `REJECTED`** (auditável), sem mexer no saldo:

```json
{"transactionId":"01a17377-0c4e-7f01-9a2b-3d0f6c1b7e55","status":"REJECTED","failureCode":"INSUFFICIENT_FUNDS","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":false}
```

HTTP `422`. A tabela de `failureCode` está no [ARCHITECTURE.md](ARCHITECTURE.md#7-máquina-de-estados-e-failurecode).

### 5. WIN e REFUND

`WIN` credita o prêmio (pode apontar para a BET com `referenceExternalTransactionId`). `REFUND` reverte uma BET e exige a referência, com **valor igual** ao da BET:

```bash
curl -s -X POST $API/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:win-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"win-1","playerId":"player-1",
       "walletId":"'$WALLET_ID'","roundId":"round-1","gameId":"game-1","kind":"WIN",
       "money":{"amount":"50.00","currency":"BRL"},"referenceExternalTransactionId":"bet-1"}'

curl -s -X POST $API/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:refund-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"refund-1","playerId":"player-1",
       "walletId":"'$WALLET_ID'","roundId":"round-1","gameId":"game-1","kind":"REFUND",
       "money":{"amount":"30.00","currency":"BRL"},"referenceExternalTransactionId":"bet-1"}'
```

(No PowerShell, use o mesmo padrão `@"..."@ | curl.exe ... -d "@-"` do exemplo 2, trocando `externalTransactionId`, `kind`, `money` e a chave.)

### 6. Reversão que chega antes da referência (202)

Um `REFUND` cuja BET ainda não chegou **não é erro**: fica `PENDING_REFERENCE` (HTTP `202`) e um worker o reavalia com backoff. Quando a BET chega, o worker aplica o `REFUND`.

```json
{"transactionId":"01a17377-3b90-7c22-a1d4-5e8f0b9d2a10","status":"PENDING_REFERENCE","balance":{"amount":"100.00","currency":"BRL"},"idempotentReplay":false}
```

### 7. Consultar uma transação

```bash
curl -s $API/wagering/transactions/01a17376-ecc2-74b8-8012-807a18320652
curl -s $API/providers/provider-a/wagering/transactions/bet-1
```

Responde `200` com o `status` no corpo (a consulta deu certo mesmo que a transação tenha sido rejeitada) ou `404 TRANSACTION_NOT_FOUND`.

### 8. Ledger paginado

```bash
curl -s "$API/wallets/$WALLET_ID/ledger?limit=2"
curl -s "$API/wallets/$WALLET_ID/ledger?limit=2&cursor=<nextCursor>"
```

`limit` vai de 1 a 200 (padrão 50). `nextCursor` é `null` na última página. Cada item traz `direction`, `money`, `balanceBefore`, `balanceAfter`, `walletVersion` e `transactionId`.

### 9. Reconciliação

Compara o saldo guardado com o saldo reconstruído pelo ledger. É `POST` por contrato, mas **só lê**:

```bash
curl -s -X POST "$API/wallets/$WALLET_ID/reconciliation"
```

```powershell
curl.exe -s -X POST "$api/wallets/$walletId/reconciliation"
```

```json
{"walletId":"01a17376-ec6f-767a-82d3-020218f778ca","storedBalance":{"amount":"70.00","currency":"BRL"},"calculatedBalance":{"amount":"70.00","currency":"BRL"},"difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"checkedEntries":2}
```

### 10. Health e métricas

```bash
curl -s $API/health/live       # {"status":"ok"}
curl -s $API/health/ready      # 200 com postgres/sqs "up", ou 503
curl -s $API/metrics           # formato Prometheus
```

Os logs saem em JSON no stdout (`docker compose logs app`). O header `X-Correlation-Id` é aceito, validado e devolvido em toda resposta.

### 11. Enviar uma mensagem pela fila de entrada

A mesma regra de negócio roda por SQS. A mensagem é um envelope `WagerTransactionRequested` com a `idempotencyKey` dentro de `data`. A fila é FIFO: precisa de `MessageGroupId` (use a `walletId`) e `MessageDeduplicationId`.

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET_ID" \
  --message-deduplication-id msg-1 \
  --message-body '{"messageId":"msg-1","type":"WagerTransactionRequested","occurredAt":"2026-01-01T00:00:00Z","data":{"idempotencyKey":"provider-a:bet-q1","providerId":"provider-a","externalTransactionId":"bet-q1","playerId":"player-1","walletId":"'$WALLET_ID'","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"5.00","currency":"BRL"}}}'
```

Alguns segundos depois, `GET /providers/provider-a/wagering/transactions/bet-q1` mostra a transação `PROCESSED`. Mensagens inválidas ou com erro permanente (JSON quebrado, wallet inexistente, payload inválido, chave em conflito) vão para a DLQ `wager-transactions-dlq.fifo`, com o motivo no atributo `failureReason`. Uma transação **rejeitada por regra de negócio** (por exemplo saldo insuficiente) não vai para a DLQ: é um resultado válido, já persistido, e a mensagem é confirmada.

Para enviar mensagens sem montar o JSON à mão, há um script que enfileira N apostas:

```bash
bun test/smoke/queue-load.ts 20
```

## Testes

Os testes de integração e de concorrência usam **PostgreSQL e LocalStack reais**, sem mocks desses dois. Eles têm uma infraestrutura própria, separada da aplicação (`docker-compose.test.yml`, portas 55432 e 45660):

```bash
bun install
bun run infra:test:up        # sobe Postgres + LocalStack de teste
```

| Comando | O que roda | Tempo aproximado* |
|---|---|---|
| `bun test` | Unitários (782) e integração (767), em sequência | ~170 s |
| `bun run test:fast` | A mesma suíte com `bun test --parallel=4` | ~50 s |
| `bun run test:concurrency` | 15 cenários com **processos `bun src/main.ts` de verdade**: 3 instâncias, crash, reinício, publishers concorrentes | ~35 s |
| `bun run smoke:scale` | Verificação contra o Compose em pé com `--scale app=3` (50 BETs iguais em paralelo, 100.00 com 2×80.00, mensagem pela fila) | ~5 s |

\* Medido numa máquina de desenvolvimento com Windows e Docker Desktop; varia com o disco e a CPU. A maior parte do tempo da suíte é espera real do SQS (visibility timeout, backoff, redrive).

Para parar a infra de teste: `bun run infra:test:down`.

**Teste de SIGTERM.** Dos 15 cenários de concorrência, um (`test/concurrency/graceful-shutdown.test.ts`) envia `SIGTERM` e confere o encerramento gracioso (a mensagem em andamento termina, é apagada da fila e o processo sai com código 0). O Windows não tem `SIGTERM` gracioso, então ele é **pulado no Windows** e roda em Linux/macOS. No Windows dá para executá-lo num container Linux ligado à rede da infra de teste:

```bash
docker run --rm --network wagering-test_default -v "$PWD:/app" -w /app \
  -e TEST_POSTGRES_HOST=postgres -e TEST_POSTGRES_PORT=5432 \
  -e TEST_LOCALSTACK_HOST=localstack -e TEST_LOCALSTACK_PORT=4566 \
  oven/bun:1.4.4 bun test --config=test/concurrency/bunfig.toml test/concurrency/graceful-shutdown.test.ts
```

(No PowerShell, troque `$PWD` por `${PWD}`.) Para rodar **toda** a suíte de concorrência em Linux, troque `test/concurrency/graceful-shutdown.test.ts` por `test/concurrency` no fim do comando.

A suíte de concorrência fica fora do `bun test` de propósito (sobe processos e leva dezenas de segundos). O que cada suíte prova está no [ARCHITECTURE.md](ARCHITECTURE.md#15-estratégia-de-testes).

Outros scripts: `bun run lint`, `bun run typecheck`, `bun run format`.

## Variáveis de ambiente principais

Todas são opcionais; os padrões já funcionam com `docker compose up`. A lista completa e comentada está em [.env.example](.env.example) (copie para `.env` para alterar algo; o `.env` não vai para o git nem para a imagem).

| Variável | Padrão | Para quê |
|---|---|---|
| `APP_ROLES` | `api,consumer,outbox,pending-worker` | Papéis do processo. Permite instâncias especializadas. |
| `APP_PORTS` | `3000-3009` | (Compose) faixa de portas do computador para as instâncias do `app` |
| `POSTGRES_PORT` | `5432` | (Compose) porta do PostgreSQL no computador |
| `LOCALSTACK_PORT` | `4566` | (Compose) porta do LocalStack no computador |
| `DB_LOCK_TIMEOUT_MS` | `5000` | Espera máxima pelo lock da wallet; estourou, `503 LOCK_TIMEOUT` |
| `CONSUMER_VISIBILITY_TIMEOUT_SECONDS` | `30` | Visibility timeout das mensagens recebidas |
| `CONSUMER_BACKOFF_BASE_SECONDS` / `_MAX_SECONDS` | `1` / `60` | Backoff de visibilidade dos retries do consumidor |
| `OUTBOX_INTERVAL_MS` / `OUTBOX_BATCH_SIZE` | `1000` / `10` | Frequência e tamanho do lote do publicador da outbox |
| `PENDING_WORKER_INTERVAL_MS` | `1000` | Frequência do worker de referências pendentes |
| `PENDING_REFERENCE_MAX_ATTEMPTS` / `_TTL_MS` | `10` / `900000` | Limites para uma referência que não chega (rejeita com `REFERENCE_NOT_FOUND`) |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `ENABLE_FAULT_INJECTION` / `FAULT_POINT` | desligado | **Só para teste**: faz o processo se matar em um ponto. Nunca em produção. |

## Estrutura do repositório

| Caminho | Conteúdo |
|---|---|
| `src/modules/wagering/` | Transações de aposta: domínio (estados, regras de referência), caso de uso, worker de pendências, consumidor SQS, HTTP |
| `src/modules/wallet/` | Wallet, ledger, reconciliação, consultas |
| `src/modules/messaging/` | Inbox, outbox, publicador, consumidor genérico de fila |
| `src/modules/auth/`, `src/modules/health/` | Ponto de extensão de autenticação (no-op) e health checks |
| `src/shared/` | `Money`, eventos de integração, Unit of Work, logs, métricas, injetor de falha |
| `migrations/` | Migrations do MikroORM (up/down) |
| `test/unit`, `test/integration`, `test/concurrency` | As três suítes; `test/support` tem os helpers; `test/smoke` tem os scripts de verificação do Compose |
| `localstack/init/` | Script que cria as 3 filas no LocalStack |
| `Dockerfile`, `docker-compose.yml` | Imagem e stack completa; `docker-compose.test.yml` é a infra dos testes |

## Problemas conhecidos e dicas

| Sintoma | Causa e solução |
|---|---|
| `port is already allocated` na 5432 | Já existe um PostgreSQL no computador. Crie um `.env` com `POSTGRES_PORT=5433` (a aplicação em container não é afetada: ela fala com o Postgres pela rede do Compose). |
| `port is already allocated` na 3000 ou 4566 | Mude `APP_PORTS` ou `LOCALSTACK_PORT` no `.env`. |
| Mensagens enfileiradas sumiram depois de parar tudo | O **LocalStack não persiste filas**: `docker compose stop` (que para todos os serviços) descarta o que estava na fila. Parar só a aplicação (`docker compose stop app`) não perde nada. Isso não acontece no SQS real. |
| Só consigo 10 instâncias | A faixa `3000-3009` tem 10 portas. Aumente `APP_PORTS` (por exemplo `3000-3019`). |
| `docker compose up` roda a migração de novo | Normal: o serviço `migrate` roda a cada `up` e, sem migrations pendentes, não faz nada. Existe sempre um só, não importa quantas instâncias. |
| Os testes falham ao conectar | Falta subir a infra de teste: `bun run infra:test:up`. |
| `/health/ready` responde 503 | Postgres ou a fila de entrada indisponível; o corpo diz qual (`checks`). |
| `bun run infra:up` | Sobe só Postgres e LocalStack (para desenvolver com a aplicação rodando fora do container, `bun run start`). |

## Documentação

- [ARCHITECTURE.md](ARCHITECTURE.md): decisões, trade-offs, interpretações e limitações.
- [docs/CHALLENGE.md](docs/CHALLENGE.md): enunciado do desafio.
