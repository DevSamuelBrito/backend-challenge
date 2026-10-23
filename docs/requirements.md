# Requisitos — Distributed Wagering Processor (Jungle Gaming)

> **Fonte única:** o arquivo [`docs/CHALLENGE.md`](CHALLENGE.md) (o enunciado estava em `README.md`, commit `76047ca`, e foi renomeado). Todas as referências "CHALLENGE.md §N" abaixo apontam para as seções numeradas desse arquivo (§N = seção "N."; "Intro" = o texto "Bem-vindo à Jungle Gaming" antes da seção 1).
>
> Este documento **não** contém código nem propõe solução. Onde o enunciado é omisso, isso aparece na seção 8, e não preenchido com suposições.

---

## 1. Visão geral

Construir um **serviço financeiro distribuído que processa transações de apostas recebidas de múltiplos provedores de jogos** (CHALLENGE.md §1). Os provedores enviam operações associadas a uma rodada, no encadeamento `BET → WIN | LOSS | REFUND | ROLLBACK` (CHALLENGE.md §3).

- A entrega das mensagens é **at-least-once**: a mesma operação pode chegar várias vezes, uma operação dependente pode chegar antes da referenciada, várias instâncias podem tocar a mesma wallet ao mesmo tempo, o processo pode morrer antes ou depois do commit, eventos podem ser publicados mais de uma vez, e PostgreSQL e SQS podem ficar temporariamente indisponíveis (CHALLENGE.md §3).
- O sistema deve permanecer correto quando mensagens forem **duplicadas**, entregues **fora de ordem** ou processadas **simultaneamente** (CHALLENGE.md §1).
- **Invariantes globais:** não duplicar créditos, não duplicar débitos, não perder eventos confirmados, não permitir saldo negativo (CHALLENGE.md §3).
- O desafio **não** avalia CRUD nem familiaridade superficial com NestJS. A avaliação é centrada em: correção financeira; concorrência entre múltiplas instâncias; idempotência persistente; consistência entre saldo materializado e ledger; processamento assíncrono e recuperação após falhas; clareza das decisões técnicas (CHALLENGE.md §1).
- "Não esperamos perfeição — esperamos raciocínio claro, código limpo e decisões justificadas." (CHALLENGE.md Intro)

---

## 2. Requisitos funcionais

### 2.1 Wallet

- [ ] `POST /wallets` cria uma wallet a partir de `playerId` e `initialBalance` (CHALLENGE.md §9 — "Criar wallet").
- [ ] Saldo inicial **maior que zero** gera uma transação interna `OPENING` **na mesma transação SQL**, com lançamento `CREDIT` correspondente no ledger (CHALLENGE.md §9 — "Criar wallet").
- [ ] Resposta de criação devolve `id`, `playerId`, `balance` e `version` (`version: 1`) (CHALLENGE.md §9 — exemplo de resposta).
- [ ] Criar wallet duplicada para o mesmo `playerId` + `currency` **falha como conflito** (CHALLENGE.md §9 — "Criar wallet"; CHALLENGE.md §6.2 — "no máximo uma wallet por `playerId` + `currency`").
- [ ] `GET /wallets/:walletId` (CHALLENGE.md §9 — "Consultas").
- [ ] `GET /wallets/:walletId/ledger?cursor=...&limit=50` com **cursor estável e opaco** (CHALLENGE.md §9 — "Consultas").
- [ ] `version` inicia em `1` após a criação e **incrementa somente quando o saldo muda** (CHALLENGE.md §6.2 — Invariantes).

### 2.2 Submissão e consulta de transações

- [ ] `POST /wagering/transactions` com header `Idempotency-Key` obrigatório (CHALLENGE.md §9 — "Submeter transação").
- [ ] `GET /wagering/transactions/:transactionId` (CHALLENGE.md §9 — "Consultas").
- [ ] `GET /providers/:providerId/wagering/transactions/:externalTransactionId` (CHALLENGE.md §9 — "Consultas").
- [ ] `OPENING` **não** pode ser submetido pela API nem pela fila (CHALLENGE.md §6.3).
- [ ] Mesma idempotency key + mesmo payload → mesma resposta com `idempotentReplay: true` (CHALLENGE.md §9 — "Idempotência").
- [ ] Mesma idempotency key + payload diferente → **conflito**, não replay (CHALLENGE.md §6.3; CHALLENGE.md §9 — "Idempotência").
- [ ] A API distingue, de forma clara e consistente entre todos os endpoints: payload inválido, conflito de idempotência, rejeição por regra de negócio, aceite com processamento pendente e falha transitória de infraestrutura (CHALLENGE.md §9 — "Status HTTP").

### 2.3 Regras de negócio por operação

- [ ] `BET`: débito, 1 entrada `DEBIT` no ledger; **rejeitar se saldo insuficiente** (CHALLENGE.md §7 — tabela).
- [ ] `WIN`: crédito, 1 entrada `CREDIT`; pode referenciar a `BET` da mesma rodada (CHALLENGE.md §7 — tabela).
- [ ] `LOSS`: nenhum efeito no saldo, nenhum lançamento; registra o resultado sem mover saldo (CHALLENGE.md §7 — tabela; CHALLENGE.md §6.4).
- [ ] `REFUND`: crédito, 1 entrada `CREDIT`; reverte uma `BET` `PROCESSED`, uma única vez (CHALLENGE.md §7 — tabela).
- [ ] `ROLLBACK`: inverso da referência, 1 entrada invertida; reverte uma transação `PROCESSED`, uma única vez (CHALLENGE.md §7 — tabela).
- [ ] `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId` (CHALLENGE.md §7 — regra 1; CHALLENGE.md §6.3 `requiresReference()`).
- [ ] Referência resolvida por `(providerId, referenceExternalTransactionId)` e deve pertencer ao **mesmo provider, player, wallet, moeda e rodada** (CHALLENGE.md §7 — regra 2).
- [ ] `REFUND` só referencia `BET`; `ROLLBACK` referencia `BET`, `WIN` ou `REFUND` (CHALLENGE.md §7 — regra 3).
- [ ] Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação (CHALLENGE.md §7 — regra 4).
- [ ] Valor de `REFUND`/`ROLLBACK` **igual** ao valor da referência; reversão parcial fora de escopo (CHALLENGE.md §7 — regra 5).
- [ ] Transação `REJECTED` não altera saldo nem gera ledger (CHALLENGE.md §7 — regra 6; CHALLENGE.md §6.4).
- [ ] Repetir operação já processada retorna **o resultado original**, incluindo o saldo observado naquele momento (CHALLENGE.md §7 — regra 7).
- [ ] Reversão que produziria saldo negativo é **rejeitada explicitamente**, com `failureCode` distinto do de aposta sem saldo, e permanece auditável (CHALLENGE.md §7 — regra 9).
- [ ] Toda rejeição carrega um `failureCode` estável e legível por máquina, suficiente para o provedor decidir se reenvia, corrige o payload ou desiste; a taxonomia é do candidato, que deve defini-la e documentá-la (CHALLENGE.md §7.2).
- [ ] Interpretações adicionais adotadas devem ser documentadas (CHALLENGE.md §7 — após a lista de regras).

### 2.4 Referências fora de ordem

- [ ] Referência ausente → persistir como `PENDING_REFERENCE` e reprocessar depois (CHALLENGE.md §7 — regra 8).
- [ ] `PENDING_REFERENCE` reprocessadas por **worker agendado** com **backoff exponencial** (CHALLENGE.md §7.1).
- [ ] Limite de tentativas ou TTL definido e justificado pelo candidato (CHALLENGE.md §7.1).
- [ ] Esgotado o limite: `REJECTED` com `failureCode` que identifique a referência inexistente, **e evento correspondente publicado** (CHALLENGE.md §7.1).

### 2.5 Reconciliação

- [ ] `POST /wallets/:walletId/reconciliation` devolve `walletId`, `storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries` (CHALLENGE.md §9 — "Reconciliação").
- [ ] Divergências **não** são corrigidas silenciosamente: devem ser **logadas**, **contabilizadas em métrica** e **sinalizadas na resposta** (CHALLENGE.md §9 — "Reconciliação").

### 2.6 Processamento por SQS

- [ ] Filas `wager-transactions.fifo` e `wager-transactions-dlq.fifo` (CHALLENGE.md §10).
- [ ] Consumidor reutiliza **o mesmo use case** da entrada HTTP (CHALLENGE.md §10).
- [ ] Deduplicação via **inbox persistente** por `(consumerName, messageId)` (CHALLENGE.md §10).
- [ ] `ack` **somente após o commit** (CHALLENGE.md §10).
- [ ] Distinguir erros de **negócio** (terminal, ack), **transitórios** (retry com backoff) e **permanentes** (DLQ) (CHALLENGE.md §10).
- [ ] Respeitar um limite de tentativas antes da DLQ (CHALLENGE.md §10).
- [ ] Em `SIGTERM`, concluir mensagens em andamento ou devolver a visibilidade (CHALLENGE.md §10).
- [ ] Suportar redelivery sem duplicar efeitos (CHALLENGE.md §10).

### 2.7 Transactional Outbox e eventos

- [ ] Persistência da transação, alteração de saldo, lançamento no ledger, registro de inbox (quando a entrada for SQS) e evento de integração **atômicos** (CHALLENGE.md §11; CHALLENGE.md §6.5).
- [ ] **Worker** publica eventos pendentes e funciona com **múltiplos publishers concorrentes**, sem perder nem duplicar indefinidamente (CHALLENGE.md §11).
- [ ] Cenário obrigatório: (1) PostgreSQL confirma o commit; (2) o processo morre antes de publicar; (3) outra instância assume; (4) o evento é publicado; (5) publicação duplicada continua segura para o consumidor (CHALLENGE.md §11).
- [ ] Evento `WagerTransactionProcessed` — qualquer transação aplicada, inclusive `LOSS` (CHALLENGE.md §11 — tabela).
- [ ] Evento `WagerTransactionRejected` — transação rejeitada por regra de negócio (CHALLENGE.md §11 — tabela).
- [ ] Evento `WalletBalanceChanged` — **somente** quando o saldo muda (CHALLENGE.md §11 — tabela).
- [ ] Evento `WagerTransactionPendingReference` — referência ausente (CHALLENGE.md §11 — tabela).
- [ ] Envelope como **classe abstrata** `IntegrationEvent<T>`, com uma subclasse concreta por evento; `eventType` e `version` no tipo; `data` carrega `MoneyProps` (nunca instância de `Money`) (CHALLENGE.md §11).

### 2.8 Observabilidade (funcional)

- [ ] `GET /health/live` (processo vivo) e `GET /health/ready` (PostgreSQL e SQS alcançáveis), sem autenticação (CHALLENGE.md §9 — "Health checks"; CHALLENGE.md §12; CHALLENGE.md §2).

### 2.9 Autenticação (opcional — ver seção 7)

- [ ] **Decisão obrigatória:** implementar **ou** documentar a não-implementação no `ARCHITECTURE.md` (CHALLENGE.md §2). Detalhes na seção 7 e 8 deste documento.

---

## 3. Requisitos não funcionais

### 3.1 Correção financeira e precisão monetária
- Dinheiro **nunca** como `number`, `float` ou `double` (CHALLENGE.md §5 — restrição 1; CHALLENGE.md §14 — eliminatória).
- `Money` imutável, escala fixa de 2 casas, string decimal na entrada e na saída (CHALLENGE.md §6.1).
- Saldo nunca negativo (CHALLENGE.md §3; CHALLENGE.md §6.2).
- Toda alteração de saldo tem lançamento correspondente no ledger e vice-versa (CHALLENGE.md §6.2).
- Ledger imutável: não sobrescrever nem excluir lançamentos (CHALLENGE.md §5 — restrição 5; CHALLENGE.md §6.4).
- Invariante final de todos os testes: `wallet.balance == saldo reconstruído pelo ledger` (CHALLENGE.md §13).

### 3.2 Concorrência
- A **unidade de concorrência é a `walletId`** (CHALLENGE.md §8).
- Correção mantida com: duas apostas disputando o mesmo saldo; múltiplos workers na mesma wallet; wallets diferentes em paralelo; **três ou mais instâncias** simultâneas (CHALLENGE.md §8).
- Sem lost update (CHALLENGE.md §6.2).
- Sem lock global compartilhado por todas as wallets (CHALLENGE.md §5 — restrição 6).
- Sem saldo como `read → calculate → update` sem controle de concorrência (CHALLENGE.md §5 — restrição 7).
- Solução correta com **múltiplas instâncias** (CHALLENGE.md §5 — restrição 8; CHALLENGE.md §14 — eliminatória "solução correta somente com uma instância").
- Estratégia livre (pessimistic locking, optimistic locking com retry limitado, update atômico condicionado ou combinação), a justificar no `ARCHITECTURE.md` (CHALLENGE.md §8).
- Recursos de ordenação e deduplicação do broker são **otimização**, não a garantia final: o banco continua responsável pelas invariantes (CHALLENGE.md §8; CHALLENGE.md §5 — restrição 3).
- Cenário obrigatório: saldo `100.00 BRL`, duas apostas de `80.00 BRL` simultâneas → exatamente uma `PROCESSED`, outra `REJECTED` por saldo insuficiente, saldo final `20.00 BRL`, exatamente **um** débito no ledger, nenhum retry duplica o débito (CHALLENGE.md §8).

### 3.3 Idempotência
- Idempotência **persistente**; **cache em memória não pode ser a garantia** (CHALLENGE.md §5 — restrição 2; CHALLENGE.md §14 — eliminatória).

### 3.4 Atomicidade e consistência com mensageria
- Inbox, alteração financeira, ledger e outbox na **mesma transação SQL** (CHALLENGE.md §6.5; CHALLENGE.md §11).
- **Não publicar eventos antes do commit** da transação financeira (CHALLENGE.md §5 — restrição 4; CHALLENGE.md §14 — eliminatória).

### 3.5 Integridade no schema
- Garantias de **unicidade, imutabilidade e não-negatividade** (descritas na seção 6 do enunciado) aplicadas **no schema do banco**, não apenas em código; o desenho do schema, constraints e índices **é avaliado** (CHALLENGE.md §5 — restrição 9).

### 3.6 Resiliência e recuperação
- Tolerar indisponibilidade temporária de PostgreSQL e SQS (CHALLENGE.md §3).
- Tolerar morte do processo antes/depois do commit (CHALLENGE.md §3).
- Recuperação após falhas e reinício do serviço, com consistência final comprovada (CHALLENGE.md §1; CHALLENGE.md §13 — concorrência item 8).
- Shutdown gracioso em `SIGTERM` (CHALLENGE.md §10).
- Retry com backoff (transitórios), DLQ (permanentes), limite de tentativas (CHALLENGE.md §10).
- Outbox com `attempts`/`nextAttemptAt`/backoff (CHALLENGE.md §6.5 — `scheduleRetry`).

### 3.7 Performance
- **Não há meta de RPS ou de latência** no enunciado. Teste de carga é diferencial, e "a qualidade do experimento e a honestidade da análise pesam mais que o número bruto" (CHALLENGE.md §14 — Diferenciais opcionais).
- Métrica de latência de processamento é exigida (CHALLENGE.md §12).

### 3.8 Tempo real
- O enunciado menciona "tempo real" apenas como característica dos problemas reais da empresa (CHALLENGE.md Intro). **Não há requisito explícito de tempo real** (ex.: WebSocket, SSE, push). O mais próximo é o processamento assíncrono por SQS e a publicação de eventos via outbox.

### 3.9 Observabilidade
- Logs estruturados (JSON) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` (CHALLENGE.md §12).
- **Sem** dados sensíveis ou payloads financeiros completos nos logs (CHALLENGE.md §12).
- Métricas, no mínimo: transações por status, duplicatas detectadas, retries, mensagens em DLQ, conflitos de lock, outbox lag e latência de processamento (CHALLENGE.md §12).
- Health checks separados para liveness e readiness (CHALLENGE.md §12).

### 3.10 Testabilidade
- Testes de unidade, integração e concorrência (ver 3.11 / CHALLENGE.md §13).
- Integração com **PostgreSQL e LocalStack/MiniStack reais em containers**; concorrência com **paralelismo real, não mocks sequenciais** (CHALLENGE.md §13).
- Testes que substituem completamente PostgreSQL e SQS por mocks são **eliminatórios** (CHALLENGE.md §14).
- Determinismo dos testes é critério de avaliação (CHALLENGE.md §14 — "Testes").

### 3.11 Testes obrigatórios (lista completa do CHALLENGE.md §13)

**Unidade**
- [ ] Operações e validações de `Money` (escala, arredondamento, entradas inválidas)
- [ ] Invariantes da `Wallet`
- [ ] Regras de `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`
- [ ] Conflito de moeda
- [ ] Idempotency key com payload divergente

**Integração (PostgreSQL e LocalStack/MiniStack reais em containers)**
- [ ] Migrations e constraints
- [ ] Atomicidade entre wallet, ledger, inbox e outbox
- [ ] Inbox e redelivery
- [ ] Publishers concorrentes sobre a mesma outbox
- [ ] Retry e DLQ
- [ ] Recuperação após reinicialização

**Concorrência (paralelismo real, não mocks sequenciais)**
- [ ] 1. a mesma aposta enviada **50 vezes em paralelo** → um único débito
- [ ] 2. operações concorrentes disputando o saldo da mesma wallet (cenário da seção 8)
- [ ] 3. wallets distintas processadas em paralelo
- [ ] 4. **≥ 3 processos/instâncias** simultâneos
- [ ] 5. worker morto **depois do commit e antes do ack**
- [ ] 6. dois publishers sobre a mesma outbox
- [ ] 7. `ROLLBACK` ou `REFUND` entregue antes da referência
- [ ] 8. reinício do serviço com comprovação da consistência final

**Também exigido:** a política de modelagem (CHALLENGE.md §6.0): construtor `private`/`protected` + factories estáticas (`create`, `from`, `rehydrate`); `rehydrate` não revalida regras de transição (CHALLENGE.md §6.0).

---

## 4. Stack e restrições técnicas

### 4.1 Obrigatória (CHALLENGE.md §4 — tabela "Obrigatória")

| Item | Escolha |
|---|---|
| Runtime / package manager / test runner | **Bun 1.x** |
| Linguagem | **TypeScript** em modo estrito |
| Framework | **NestJS** |
| Banco | **PostgreSQL** |
| Mensageria | **AWS SQS** via **LocalStack** ou **MiniStack** |
| Orquestração local | **Docker Compose** |
| Migrations | versionadas e reversíveis |

### 4.2 ORM (CHALLENGE.md §4 — "ORM")

Use **uma** das opções:
- **MikroORM — preferencial** (Unit of Work e Identity Map explícitos, `EntityManager.transactional()`, `LockMode`);
- **TypeORM** — aceito.

**Prisma e outros ORMs estão fora do escopo.** A escolha, o mapeamento do `Money` e a estratégia transacional adotada devem ser justificados em `ARCHITECTURE.md`.

### 4.3 Proibido / restrições invioláveis (CHALLENGE.md §5)

1. Não usar `number`, `float` ou `double` para dinheiro.
2. Não usar cache em memória como garantia de idempotência.
3. Não confiar apenas em SQS FIFO para garantir consistência.
4. Não publicar eventos antes do commit da transação financeira.
5. Não sobrescrever nem excluir lançamentos do ledger.
6. Não usar lock global compartilhado por todas as wallets.
7. Não implementar saldo como `read → calculate → update` sem controle de concorrência.
8. A solução deve estar correta com **múltiplas instâncias** da aplicação.
9. As garantias de unicidade, imutabilidade e não-negatividade descritas na seção 6 devem ser aplicadas **no schema do banco**, não apenas em código de aplicação. O desenho do schema, das constraints e dos índices é parte do que está sendo avaliado.

### 4.4 Restrições de modelagem

- O domínio **não** depende de tipos monetários do ORM nem de decorators do NestJS (CHALLENGE.md §6.1).
- Construtor `private`/`protected` + factories estáticas (CHALLENGE.md §6.0).
- Estado encapsulado e transições explícitas (CHALLENGE.md §6.0).
- Nomes e assinaturas podem ser adaptados, desde que as garantias sejam preservadas (CHALLENGE.md §6).
- Autenticação, se implementada: **Identity Provider externo** (Keycloak, Zitadel ou equivalente); **nada de tabela própria de usuários com hash de senha** (CHALLENGE.md §2).

### 4.5 Recomendado / sugerido

- MikroORM (preferencial) (CHALLENGE.md §4).
- Keycloak ou Zitadel como IdP, se houver autenticação (CHALLENGE.md §2).
- `version` para optimistic locking — "sugerido", outra estratégia aceita se justificada (CHALLENGE.md §6.2).
- Default recomendado da idempotency key: `"{providerId}:{externalTransactionId}"` (CHALLENGE.md §9).
- Ponto de extensão para auth, se não implementada: `AuthGuard` no-op ou `ProviderIdentityPort` (CHALLENGE.md §2).
- Moeda única `BRL` aceita para reduzir escopo, desde que o modelo continue multi-moeda e os conflitos de moeda sejam testados (CHALLENGE.md §6.1).

---

## 5. Contratos e regras de negócio (cópia literal)

> Trechos copiados do CHALLENGE.md sem resumo. Origem entre colchetes.

### 5.1 Money [CHALLENGE.md §6.1]

````ts
// DTO — interface é adequada aqui
interface MoneyProps {
  amount: string;   // decimal string, ex.: "25.00"
  currency: string; // ISO-4217
}

class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money;
  static zero(currency: string): Money;

  add(other: Money): Money;
  subtract(other: Money): Money;
  negate(): Money;

  isZero(): boolean;
  isPositive(): boolean;
  isNegative(): boolean;
  isLessThan(other: Money): boolean;
  equals(other: Money): boolean;

  toJSON(): MoneyProps;
  toString(): string;

  private assertSameCurrency(other: Money): void;
}
````

`Money` é **imutável**: toda operação retorna uma nova instância.

Regras:

- `amount` é **recebido e serializado como string decimal**, sempre com escala fixa de **2** casas;
- operações entre moedas diferentes lançam erro de domínio;
- entradas inválidas são rejeitadas: `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas decimais, valores negativos em contratos de entrada;
- o domínio **não** depende de tipos monetários do ORM nem de decorators do NestJS;
- na persistência, valor e moeda podem ocupar colunas separadas, desde que a representação seja exata e reidratada como `Money`.

Para reduzir escopo, **todo o desafio pode assumir uma única moeda (`BRL`)**, desde que o modelo continue multi-moeda e os conflitos de moeda sejam testados.

Formato nos contratos:

````json
{ "amount": "25.00", "currency": "BRL" }
````

> **Sobre arredondamento:** o enunciado **não define regra de arredondamento** (modo, half-up etc.). A única regra literal é "mais de 2 casas decimais" ser entrada inválida (rejeitada), e a lista de testes de unidade cita "escala, arredondamento" (CHALLENGE.md §13). Ver seção 8.

### 5.2 Enums de domínio [CHALLENGE.md §6.3, §6.4]

````ts
enum WagerTransactionKind {
  Opening  = "OPENING",   // interno: crédito de abertura da wallet
  Bet      = "BET",
  Win      = "WIN",
  Loss     = "LOSS",
  Refund   = "REFUND",
  Rollback = "ROLLBACK",
}

enum WagerTransactionStatus {
  Pending          = "PENDING",            // aceita, ainda não aplicada
  PendingReference = "PENDING_REFERENCE",  // aguardando a transação referenciada
  Processed        = "PROCESSED",          // aplicada (terminal)
  Rejected         = "REJECTED",           // violação de regra de negócio (terminal)
  Failed           = "FAILED",             // erro permanente de infraestrutura (terminal, auditável)
}

enum LedgerDirection { Debit = "DEBIT", Credit = "CREDIT" }
````

`PROCESSED`, `REJECTED` e `FAILED` são **terminais**: uma transação que chegou a um deles não muda mais de estado, e tentar transicioná-la é erro de programação, não caminho de negócio. Defina e documente as transições válidas. [CHALLENGE.md §6.3]

- `OPENING` é **interno**: não pode ser submetido pela API nem pela fila.
- A mesma idempotency key com payload diferente é **conflito**, não replay.

### 5.3 Regras de negócio [CHALLENGE.md §7]

| Operação | Efeito no saldo | Ledger | Regra principal |
|---|---|---|---|
| `BET` | débito | 1 entrada `DEBIT` | rejeitar se saldo insuficiente |
| `WIN` | crédito | 1 entrada `CREDIT` | pode referenciar a `BET` da mesma rodada |
| `LOSS` | nenhum | nenhuma | registra o resultado sem mover saldo |
| `REFUND` | crédito | 1 entrada `CREDIT` | reverte uma `BET` `PROCESSED`, uma única vez |
| `ROLLBACK` | inverso da referência | 1 entrada invertida | reverte uma transação `PROCESSED`, uma única vez |

Regras adicionais:

1. `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`.
2. A referência é resolvida por `(providerId, referenceExternalTransactionId)` e deve pertencer ao **mesmo provider, player, wallet, moeda e rodada**.
3. `REFUND` só referencia `BET`. `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`.
4. Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação.
5. O valor de `REFUND`/`ROLLBACK` deve ser **igual** ao valor da referência (reversão parcial está fora de escopo).
6. Transação `REJECTED` não altera saldo nem gera ledger.
7. Repetir uma operação já processada retorna **o resultado original**, incluindo o saldo observado naquele momento.
8. Referência ausente → persistir como `PENDING_REFERENCE` e reprocessar depois (ver 7.1).
9. Reversão que produziria saldo negativo é **rejeitada explicitamente**, com um `failureCode` distinto do de uma aposta sem saldo — são situações operacionalmente diferentes — e permanece auditável.

Qualquer interpretação adicional adotada deve ser documentada.

**7.1 Referências fora de ordem**

- Transações `PENDING_REFERENCE` são reprocessadas por um **worker agendado** com backoff exponencial.
- Limite de tentativas ou TTL definido e justificado por você.
- Esgotado o limite: `REJECTED` com um `failureCode` que identifique a referência inexistente, e evento correspondente publicado.

**7.2 Códigos de falha**

Toda rejeição precisa carregar um `failureCode` estável e legível por máquina, suficiente para o provedor decidir se reenvia, corrige o payload ou desiste. A taxonomia é sua — defina-a e documente-a.

> **Códigos de erro:** o enunciado **não fornece nenhum código concreto** (nem `failureCode`, nem mapeamento HTTP). O tipo `FailureCode` aparece nos esqueletos (§6.3) sem definição. Ver seção 8.

### 5.4 Idempotência [CHALLENGE.md §9 — "Idempotência"]

- o header `Idempotency-Key` é obrigatório e é a fonte da verdade;
- default recomendado: `"{providerId}:{externalTransactionId}"`;
- `payloadHash` = hash de um **JSON canônico** (chaves ordenadas) do subconjunto de campos de negócio — o header e metadados de transporte não entram no hash. O algoritmo deve estar documentado;
- requisição idêntica → mesma resposta, `idempotentReplay: true`;
- mesma key com payload diferente → conflito, e **não** replay.

**Status HTTP:** o mapeamento é decisão sua, mas a API precisa distinguir com clareza — e de forma consistente entre todos os endpoints — payload inválido, conflito de idempotência, rejeição por regra de negócio, aceite com processamento pendente e falha transitória de infraestrutura. Colapsar essas situações em um mesmo código obriga o provedor a interpretar mensagem de erro para decidir se pode reenviar.

### 5.5 API HTTP [CHALLENGE.md §9]

**Criar wallet**

````http
POST /wallets
````

````json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}
````

O saldo inicial, quando maior que zero, gera uma transação interna `OPENING` **na mesma transação SQL**, com lançamento `CREDIT` correspondente no ledger.

````json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "1000.00", "currency": "BRL" },
  "version": 1
}
````

Criar wallet duplicada para o mesmo `playerId` + `currency` deve falhar como conflito.

**Consultas**

````http
GET /wallets/:walletId
GET /wallets/:walletId/ledger?cursor=...&limit=50   # cursor estável e opaco
GET /wagering/transactions/:transactionId
GET /providers/:providerId/wagering/transactions/:externalTransactionId
````

**Submeter transação**

````http
POST /wagering/transactions
Idempotency-Key: provider-a:transaction-123
````

````json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
````

````json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
````

**Reconciliação**

````http
POST /wallets/:walletId/reconciliation
````

````json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance":     { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" },
  "difference":        { "amount": "0.00",   "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 42
}
````

Divergências **não** são corrigidas silenciosamente: devem ser logadas, contabilizadas em métrica e sinalizadas na resposta.

**Health checks**

````http
GET /health/live     # processo vivo
GET /health/ready    # PostgreSQL e SQS alcançáveis
````

Os endpoints de health **não** devem exigir autenticação.

### 5.6 Mensagem SQS [CHALLENGE.md §10]

Filas:

````
wager-transactions.fifo
wager-transactions-dlq.fifo
````

Mensagem:

````json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
````

O consumidor deve:

- reutilizar **o mesmo use case** da entrada HTTP;
- deduplicar via **inbox persistente** por `(consumerName, messageId)`;
- fazer `ack` **somente após o commit**;
- distinguir erros de **negócio** (terminal, ack), **transitórios** (retry com backoff) e **permanentes** (DLQ);
- respeitar um limite de tentativas antes da DLQ;
- em `SIGTERM`, concluir mensagens em andamento ou devolver a visibilidade;
- suportar redelivery sem duplicar efeitos.

### 5.7 Eventos de integração [CHALLENGE.md §11]

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive `LOSS` |
| `WagerTransactionRejected` | transação rejeitada por regra de negócio |
| `WalletBalanceChanged` | **somente** quando o saldo muda |
| `WagerTransactionPendingReference` | referência ausente |

Envelope — **classe abstrata**, com uma subclasse concreta por evento:

````ts
interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) { /* ... */ }

  /** Envelope serializado gravado no payload da outbox. */
  toJSON(): {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: string;   // ISO-8601
    version: number;
    data: T;
  };
}
````

Exemplo de subclasse — o `eventType` e a `version` ficam **no tipo**, não em uma string solta no call site:

````ts
interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged;
}
````

`data` carrega `MoneyProps` (string decimal), nunca a instância de `Money` — o payload precisa ser JSON estável e versionável.

> O enunciado só dá o `data` de **um** evento (`WalletBalanceChanged`). O `data` dos outros três eventos **não é especificado**. Ver seção 8.

### 5.8 Cenário obrigatório de concorrência [CHALLENGE.md §8]

Saldo inicial `100.00 BRL`. Duas apostas de `80.00 BRL` processadas simultaneamente.

Resultado esperado:

- exatamente uma aposta `PROCESSED`;
- a outra `REJECTED` por saldo insuficiente;
- saldo final `20.00 BRL`;
- exatamente **um** lançamento de débito no ledger;
- nenhum retry duplica o débito.

### 5.9 Esqueletos de referência do modelo de domínio [CHALLENGE.md §6.0, §6.2–§6.5]

> "Os blocos abaixo são **esqueletos de referência**: o que importa é que o estado seja encapsulado e as transições sejam explícitas." [CHALLENGE.md §6.0]

**Wallet [CHALLENGE.md §6.2]**

````ts
class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet;

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet;

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }

  // Aplicam a movimentação mantendo saldo e ledger consistentes entre si.
  // Assinatura e retorno são decisão sua.
  debit(/* ... */): /* ... */;
  credit(/* ... */): /* ... */;

  private assertSameCurrency(money: Money): void;
}
````

Invariantes:

- no máximo **uma wallet por `playerId` + `currency`**;
- saldo nunca negativo;
- **toda alteração de saldo tem um lançamento correspondente no ledger** (e vice-versa);
- operações concorrentes não podem causar lost update;
- a moeda da operação deve ser igual à moeda da wallet;
- `version` inicia em `1` após a criação e **incrementa somente quando o saldo muda**.

`version` é sugerido para optimistic locking, mas outra estratégia é aceita se justificada.

**WagerTransaction [CHALLENGE.md §6.3]**

````ts
class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction;
  static rehydrate(state: WagerTransactionState): WagerTransaction;

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }

  // ---- transições (lançam InvalidTransactionStateError se o estado atual for terminal)
  markProcessed(referenceTransactionId: string | undefined, at: Date): void;
  markPendingReference(): void;
  reject(code: FailureCode): void;
  fail(code: FailureCode): void;

  // ---- consultas de domínio
  isTerminal(): boolean;
  affectsBalance(): boolean;      // false para LOSS
  requiresReference(): boolean;   // true para REFUND e ROLLBACK
  matchesPayload(payloadHash: string): boolean;
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection;
}
````

**WalletLedgerEntry (imutável) [CHALLENGE.md §6.4]**

````ts
class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry;
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry;

  /** balanceBefore ± money === balanceAfter. Verificada na factory. */
  isBalanced(): boolean;
}
````

**Sem campos mutáveis e sem métodos de transição** — a imutabilidade é estrutural, não uma convenção. `create` valida a aritmética do lançamento.

- Uma transação financeira produz **no máximo um lançamento por wallet**.
- Operações sem efeito no saldo (`LOSS`, e qualquer transação `REJECTED`) **não geram lançamento**.
- Ledger de **partidas dobradas** (*double-entry bookkeeping*) é diferencial opcional, não requisito.

**Inbox e Outbox [CHALLENGE.md §6.5]**

````ts
class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage;
  static rehydrate(state: InboxMessageState): InboxMessage;

  get processedAt(): Date | undefined { return this._processedAt; }

  isProcessed(): boolean;
  markProcessed(at: Date): void;
}

class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage;
  static rehydrate(state: OutboxMessageState): OutboxMessage;

  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date | undefined { return this._nextAttemptAt; }
  get publishedAt(): Date | undefined { return this._publishedAt; }

  isPending(): boolean;
  isDue(now: Date): boolean;
  markPublished(at: Date): void;
  /** incrementa attempts e calcula o próximo nextAttemptAt (backoff) */
  scheduleRetry(now: Date): void;
}
````

Inbox, alteração financeira, ledger e outbox participam da **mesma transação SQL**.

---

## 6. Entrega e avaliação

### 6.1 Como entregar / prazo

- **O enunciado não informa** forma de entrega (repositório, zip, PR, link), **prazo**, canal de envio nem duração do timebox. Há apenas a menção a "dimensionar o timebox" (CHALLENGE.md §2) e a "apresentação" (CHALLENGE.md §2) sem detalhes. Ver seção 8.

### 6.2 Documentação exigida (CHALLENGE.md §14 — área "Documentação", 5 pts)

- [ ] `README.md` com **setup e comandos**.
- [ ] `ARCHITECTURE.md` com **decisões, trade-offs e limitações**.

Conteúdos que o enunciado manda documentar (e que, por dedução do próprio texto, caem no `ARCHITECTURE.md` ou na documentação em geral):

| O que documentar | Onde o enunciado diz | Destino explícito |
|---|---|---|
| Decisão de **não** implementar autenticação, desenho que adotaria e ponto de extensão | CHALLENGE.md §2 | `ARCHITECTURE.md` (explícito) |
| Escolha do ORM, mapeamento do `Money` e estratégia transacional | CHALLENGE.md §4 | `ARCHITECTURE.md` (explícito) |
| Estratégia de concorrência (pessimistic / optimistic / update atômico) | CHALLENGE.md §8 | `ARCHITECTURE.md` (explícito) |
| Transições válidas de `WagerTransaction` | CHALLENGE.md §6.3 ("Defina e documente") | não especificado |
| Algoritmo do `payloadHash` | CHALLENGE.md §9 ("O algoritmo deve estar documentado") | não especificado |
| Taxonomia de `failureCode` | CHALLENGE.md §7.2 ("defina-a e documente-a") | não especificado |
| Interpretações adicionais das regras de negócio | CHALLENGE.md §7 | não especificado |
| Limite de tentativas/TTL do `PENDING_REFERENCE` (justificado) | CHALLENGE.md §7.1 | não especificado |
| Mapeamento de status HTTP (decisão do candidato) | CHALLENGE.md §9 | não especificado |
| Metodologia do teste de carga (se feito): ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência, outbox lag | CHALLENGE.md §14 | não especificado |

### 6.3 Critérios de avaliação — 100 pontos (CHALLENGE.md §14)

| Área | Pontos | O que será observado |
|---|---|---|
| Correção financeira | 20 | `Money`, saldo, ledger, reversões, reconciliação |
| Concorrência | 20 | lost updates, hot wallet, múltiplas instâncias, locks |
| Idempotência | 15 | dedup persistente, replay, payload conflitante |
| Mensageria e falhas | 15 | inbox, outbox, retry, DLQ, crash recovery, shutdown |
| Modelagem e arquitetura | 10 | invariantes encapsuladas em classes, boundaries, portas, simplicidade |
| Testes | 10 | integração real, races, determinismo, cobertura de falhas |
| Observabilidade | 5 | logs, métricas, health checks, diagnóstico |
| Documentação | 5 | `README.md` com setup e comandos, `ARCHITECTURE.md` com decisões, trade-offs e limitações |

**Autenticação não vale pontos** (CHALLENGE.md §2).

### 6.4 Falhas eliminatórias (CHALLENGE.md §14)

- `number` para dinheiro;
- saldo negativo causado por race;
- débito ou crédito duplicado;
- idempotência apenas em memória;
- solução correta somente com uma instância;
- publicação de evento antes do commit;
- ausência de ledger auditável;
- testes que substituem completamente PostgreSQL e SQS por mocks.

### 6.5 Uso de IA

- **O enunciado não contém nenhuma regra sobre uso (ou proibição) de IA.** Nenhuma ocorrência do tema no CHALLENGE.md. Ver seção 8.
- Indício indireto: as decisões "serão discutidas na apresentação" (CHALLENGE.md §2) e o lema "raciocínio claro, código limpo e decisões justificadas" (CHALLENGE.md Intro) — ou seja, é de se esperar que o candidato saiba defender o código.

---

## 7. Bônus e diferenciais (opcionais)

Nenhum destes é obrigatório. O enunciado **não informa se geram pontos extras** além dos 100 da tabela; apenas os chama de "diferencial".

- [ ] **Teste de carga** — "também conta como diferencial". Se fizer: expor como `bun run test:load` e registrar ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox lag. Sem meta de RPS; "a qualidade do experimento e a honestidade da análise pesam mais que o número bruto". (CHALLENGE.md §14 — "Diferenciais opcionais")
- [ ] **Ledger de partidas dobradas** (*double-entry bookkeeping*) — "diferencial opcional, não requisito". (CHALLENGE.md §6.4)
- [ ] **OpenTelemetry** — opcional. (CHALLENGE.md §12)
- [ ] **Dashboard** — opcional. (CHALLENGE.md §12)
- [ ] **Autenticação via Identity Provider externo** (Keycloak, Zitadel ou equivalente) — opcional; **não vale pontos**; se não fizer, documentar. (CHALLENGE.md §2)
- [ ] **Múltiplas moedas** — o modelo deve ser multi-moeda, mas assumir só `BRL` é aceito (CHALLENGE.md §6.1). Não é bônus, mas é um escopo que o próprio enunciado autoriza reduzir.

---

## 8. Ambiguidades e dúvidas

> Para decidir ou perguntar à empresa. Cada item cita onde o problema aparece. Itens marcados **[CRÍTICO]** impactam diretamente a modelagem, o schema ou a avaliação.

### 8.1 Lacunas de entrega (omissões totais)

1. **[CRÍTICO] Prazo de entrega:** não consta no CHALLENGE.md. Há menção a "dimensionar o timebox" (CHALLENGE.md §2), mas nenhum valor.
2. **Forma de entrega:** repositório público/privado? Fork? Zip? PR? Para quem/onde enviar? Não consta.
3. **[CRÍTICO] Regras sobre uso de IA:** não há nenhuma. Permitido? Precisa declarar? Perguntar, já que o enunciado cita "apresentação" onde as decisões serão discutidas (CHALLENGE.md §2).
4. **Formato da "apresentação"** citada em CHALLENGE.md §2 (duração, audiência, o que apresentar, se há demo ao vivo) — não consta.
5. **README.md do candidato:** o enunciado exige que o candidato entregue um `README.md` com setup e comandos (CHALLENGE.md §14). Com o enunciado agora em `docs/CHALLENGE.md`, a raiz fica livre para esse README; confirmar apenas se o enunciado deve permanecer no repositório entregue.
6. **Onde documentar** vários itens "defina e documente" (transições, `payloadHash`, `failureCode`, interpretações) — só alguns têm destino explícito (`ARCHITECTURE.md`); ver 6.2.
7. **Ambiente de execução esperado:** versões mínimas, SO, comandos esperados (`bun test`? `bun run test:integration`? `docker compose up`?). Só `bun run test:load` é citado literalmente.

### 8.2 Dinheiro / `Money`

8. **[CRÍTICO] Arredondamento:** CHALLENGE.md §13 pede testar "escala, arredondamento", mas CHALLENGE.md §6.1 diz que mais de 2 casas decimais é **entrada inválida** (rejeitar). Qual é o papel de "arredondamento" então? Existe alguma operação (ex.: resultado de `add`/`subtract`) que possa gerar mais de 2 casas? O enunciado não define modo de arredondamento.
9. **Valor zero:** `"0.00"` é aceito em `BET/WIN/REFUND/ROLLBACK`? CHALLENGE.md §6.1 rejeita "valores negativos em contratos de entrada" mas não menciona zero; CHALLENGE.md §9 só diz que `initialBalance` "quando maior que zero" gera `OPENING` (o que implica que zero é aceito na criação da wallet).
10. **Valor máximo / precisão total** (número de dígitos inteiros) não é definido — impacta o tipo numérico do banco.
11. **Biblioteca `Decimal`:** CHALLENGE.md §6.1 usa o tipo `Decimal` no esqueleto sem dizer qual biblioteca (decimal.js, big.js, etc.) — escolha livre?
12. **Formato de `amount`:** aceitar `"25"` ou `"25.0"` (escala menor que 2)? O enunciado diz "sempre com escala fixa de 2 casas" para recebido e serializado — rejeitar ou normalizar? Zeros à esquerda? Sinal `+`?
13. **Validação de `currency`:** "ISO-4217" é citado, mas não está dito se é preciso validar contra a lista oficial ou só formato (3 letras maiúsculas).

### 8.3 Idempotência

14. **[CRÍTICO] Duas chaves de unicidade possíveis:** `Idempotency-Key` (fonte da verdade) vs. `(providerId, externalTransactionId)` (usada para resolver referências e na consulta `GET /providers/:providerId/...`). O que acontece se a mesma `externalTransactionId` chegar com `Idempotency-Key` diferente? Ou a mesma key com `providerId`/`externalTransactionId` diferentes? Não está definido.
15. **Escopo da key:** é global ou por `providerId`? O default sugerido já embute `providerId`, mas a key é livre.
16. **Body HTTP vs. mensagem SQS:** a mensagem SQS traz `idempotencyKey` dentro de `data`; a requisição HTTP traz a key apenas no header e **não** no body. Como mapear isso para um mesmo use case (CHALLENGE.md §10) e para o `payloadHash` ("header e metadados de transporte não entram no hash" — mas `idempotencyKey` no SQS está dentro de `data`)? Essa chave entra no hash no caso SQS?
17. **Quais são exatamente os "campos de negócio"** do hash? O enunciado diz "subconjunto de campos de negócio" sem listar. `referenceExternalTransactionId` entra? Aparece nos esqueletos e nas regras, mas **não aparece nos exemplos de payload** (HTTP e SQS) — ver item 22.
18. **Dois níveis de dedup (HTTP/idempotency key e SQS/inbox):** se a mesma transação chegar por HTTP e por SQS, e o `messageId` for diferente, vale a idempotency key? Qual a resposta/efeito? E uma mesma `messageId` com `payloadHash` diferente no inbox (o `InboxMessage` guarda `payloadHash`): é conflito? Qual o tratamento (ack? DLQ?)?
19. **Replay de transações `REJECTED`/`PENDING_REFERENCE`:** `idempotentReplay: true` também se aplica? Qual o corpo/`balance` retornado? O exemplo de resposta (§9) só mostra `PROCESSED`.
20. **"Resultado original, incluindo o saldo observado naquele momento"** (CHALLENGE.md §7 regra 7): para `LOSS` e `REJECTED` (que não têm lançamento), de onde vem o saldo "observado naquele momento"? O enunciado não diz se deve ser persistido na transação.

### 8.4 Regras de negócio

21. **[CRÍTICO] Regra 4 (revertida "duas vezes pelo mesmo tipo de operação") vs. invariante "não duplicar créditos":** a redação permite, em tese, uma `BET` receber **um** `REFUND` e **um** `ROLLBACK` (tipos diferentes). Isso geraria duas reversões de uma mesma aposta. Mas a tabela diz que ambos revertem "uma única vez". É permitido ou não? O enunciado não esclarece. Ver também `ROLLBACK` de `REFUND` (CHALLENGE.md §7 regra 3).
22. **`referenceExternalTransactionId` ausente dos exemplos:** consta no esqueleto (§6.3) e nas regras (§7), mas **não** aparece nos payloads de exemplo HTTP (§9) nem SQS (§10). Confirmar que é um campo opcional adicional nos dois contratos e se `WIN` (que "pode referenciar" a `BET`) o usa.
23. **`WIN` com referência:** "pode referenciar a BET da mesma rodada" — é opcional? Se informada e a `BET` não existe, vira `PENDING_REFERENCE` (regra 8) ou é aceita? Se existe mas pertence a outra rodada/wallet, qual falha? E `WIN` sem `BET` correspondente na rodada: aceitar?
24. **`LOSS` com referência:** pode/deve referenciar `BET`? O enunciado não cita referência para `LOSS` (CHALLENGE.md §7).
25. **`ROLLBACK` de `LOSS` ou de `ROLLBACK`/`OPENING`:** não listados na regra 3 — presumivelmente inválidos, mas qual falha e se deve ser `REJECTED` ou erro de payload é indefinido.
26. **Referência existente, mas não `PROCESSED`:** se a referência está `REJECTED`, `FAILED`, `PENDING` ou `PENDING_REFERENCE`, o que acontece com o `REFUND`/`ROLLBACK`? Fica pendente (esperando processamento da referência)? É rejeitado? A regra 8 trata só de referência *ausente* e a tabela diz "reverte uma `BET` `PROCESSED`".
27. **Referência encontrada mas violando regra 2** (outro player, wallet, moeda, rodada, provider): `REJECTED` com qual código? É o mesmo caso de "ausente" (já que a resolução é por `(providerId, referenceExternalTransactionId)`)? Ou erro de validação (4xx)?
28. **Valor ≠ referência:** (regra 5) `REJECTED` — presume-se, mas não é dito.
29. **Efeito do `ROLLBACK` por tipo de referência:** "inverso da referência" — derivável (BET→crédito, WIN→débito, REFUND→débito), porém o enunciado não explicita; só está implícito em `ledgerDirectionFor(reference?)`. Confirmar.
30. **`ROLLBACK`/`REFUND` com a `PENDING_REFERENCE` já gerada e a referência chegando depois:** quem aciona o reprocessamento — só o worker agendado (CHALLENGE.md §7.1) ou também a chegada da referência? Latência aceitável?
31. **Wallet inexistente** (`walletId` desconhecido) em `POST /wagering/transactions` ou na fila: 404? `REJECTED`? DLQ? Não definido.
32. **`playerId` do payload ≠ `playerId` da wallet:** erro de que tipo?
33. **Moeda da operação ≠ moeda da wallet:** CHALLENGE.md §6.2 exige igualdade, CHALLENGE.md §6.1 diz "erro de domínio" — como isso aparece na API/fila (rejeição de negócio persistida? 4xx?). Persiste uma transação `REJECTED` ou não persiste nada?
34. **Que erros geram `REJECTED` (persistido) e quais são só "payload inválido" (não persistido)?** O enunciado fala em "violação de regra de negócio" (REJECTED) vs. "payload inválido" (status HTTP), mas a fronteira não é traçada.
35. **Quando usar `FAILED`:** "erro permanente de infraestrutura (terminal, auditável)" — qual a relação com a DLQ ("permanentes (DLQ)")? Toda mensagem na DLQ vira transação `FAILED`? E em HTTP? E existe evento para `FAILED`? (Não está entre os 4 eventos mínimos.)
36. **Status `PENDING`:** "aceita, ainda não aplicada". Em que fluxo ela existe de forma observável? O exemplo HTTP retorna `PROCESSED` de forma síncrona; "aceite com processamento pendente" (CHALLENGE.md §9) sugere que o HTTP pode responder antes de processar. A submissão HTTP é síncrona (processa e responde) ou assíncrona (enfileira)? Não é dito.
37. **Transições válidas:** "Defina e documente as transições válidas" — por exemplo, `PENDING_REFERENCE → PENDING`? `PENDING_REFERENCE → PROCESSED` direto? Não há tabela; livre mas precisa ser documentada.
38. **Reversão que deixa saldo negativo (regra 9):** distinto de saldo insuficiente na `BET` — mas o código exato é livre (taxonomia própria).

### 8.5 Wallet

39. **IDs:** os exemplos parecem UUID v7, mas isso não é exigido. `Wallet.open` recebe o `id` como parâmetro — quem gera (cliente, servidor)? Em `POST /wallets` o body não traz `id`.
40. **Wallet criada com saldo zero:** sem `OPENING`/ledger, `version = 1` (por dedução). Confirmar. `initialBalance` é obrigatório no body?
41. **Idempotência de `POST /wallets`:** o enunciado define só conflito para duplicidade por `playerId + currency`; não há `Idempotency-Key` aqui. Retry do cliente = conflito (sem replay)?
42. **`OPENING` gera eventos?** (`WalletBalanceChanged`, `WagerTransactionProcessed`?). Os eventos mínimos são definidos para "transação aplicada" e "quando o saldo muda"; `OPENING` é uma transação interna que muda o saldo. Não é dito se emite.
43. **Para `OPENING`:** quais valores de `providerId`, `externalTransactionId`, `idempotencyKey`, `roundId`, `gameId` (todos campos `readonly` obrigatórios nos esqueletos)? O enunciado não diz.

### 8.6 HTTP

44. **[CRÍTICO] Mapeamento de status HTTP** é livre, mas precisa distinguir cinco situações (payload inválido; conflito de idempotência; rejeição de negócio; aceite com processamento pendente; falha transitória). Decisão do candidato, a documentar.
45. **Resposta de rejeição de negócio:** HTTP retorna a transação com `status: REJECTED` + `failureCode` (e com qual HTTP status)? O corpo de erro não é especificado.
46. **Corpos de resposta das consultas** (`GET /wallets/:id`, `GET /wallets/:id/ledger`, `GET /wagering/transactions/...`) não são especificados — só o do `POST`s e da reconciliação.
47. **Ledger paginado:** ordem (mais recente primeiro?), `limit` máximo/default (exemplo: 50), formato da resposta (nome do campo do próximo cursor, itens) — não definidos. Só "cursor estável e opaco".
48. **Reconciliação:** é `POST` mas parece operação de leitura; é read-only? Como se calcula `checkedEntries`? Qual HTTP status quando `consistent: false`? Concorrência da reconciliação com escrita (snapshot) não é discutida.
49. **Autenticação "no escopo do que não cobre":** CHALLENGE.md §2 diz que mensagens da fila são canal interno confiável, mas "a identidade do provedor contida na mensagem continua sujeita às mesmas validações de domínio" — que validações são essas? Não há definição de "identidade do provedor" (lista de providers conhecidos? cadastro?).
50. **Provedores:** não há cadastro/API de providers. Qualquer `providerId` string é aceito?

### 8.7 SQS / mensageria

51. **[CRÍTICO] Destino dos eventos publicados pela outbox:** o enunciado nomeia apenas `wager-transactions.fifo` e `wager-transactions-dlq.fifo` (entrada). **Para onde** o worker de outbox publica os eventos (fila SQS nova? SNS? outra)? Quem é o "consumidor" do evento duplicado ("uma publicação duplicada continua segura para o consumidor")? Não existe consumidor especificado.
52. **FIFO:** `MessageGroupId` e `MessageDeduplicationId` não são especificados (escolha livre; recomenda-se justificar). A fila de entrada é `.fifo`, e a restrição 3 diz para não depender só dele.
53. **Limite de tentativas antes da DLQ** ("respeitar um limite") — valor livre? (`maxReceiveCount` e/ou contador na aplicação.) E o backoff de retry transitório (visibility timeout?) — livre.
54. **Mensagem inválida / veneno** (JSON malformado, `kind: OPENING`, etc.): ack, DLQ ou `FAILED`? A classificação entre "negócio", "transitório" e "permanente" é dada em termos gerais mas sem exemplos.
55. **Mensagem com `type` diferente de `WagerTransactionRequested`:** comportamento não definido.
56. **Outbox:** número máximo de tentativas / estado "morto"; ordem de publicação por aggregate; frequência de polling; critério de "lag" — não definidos (`attempts`, `nextAttemptAt`, backoff existem no esqueleto).
57. **Quem produz mensagens `WagerTransactionRequested`** na fila? (Provedores? Um script de teste? A própria API HTTP?) Para testes, precisa haver um produtor; não é especificado se o repositório deve incluir um.
58. **`consumerName`:** valor e semântica (um por consumer/handler?) não são especificados.
59. **`correlationId`/`causationId`:** de onde vêm (header, `messageId`, gerado)? Não é definido.
60. **`aggregateId` dos eventos:** é `walletId`, `transactionId`? Não é dito (exemplo só para `WalletBalanceChanged`, cujo `data` tem ambos).
61. **`data` dos outros 3 eventos** (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`) não é especificado, só o de `WalletBalanceChanged`.

### 8.8 Concorrência

62. **`WagerTransaction` e unicidade:** quais constraints exatas? O enunciado diz que unicidade/imutabilidade/não-negatividade ficam no schema (CHALLENGE.md §5 — restrição 9), mas não lista as chaves (ex.: se a unicidade é por `idempotencyKey`, por `(providerId, externalTransactionId)` ou ambas — liga ao item 14).
63. **Imutabilidade no banco:** como garantir (trigger? revoke de UPDATE/DELETE?) é livre, mas é avaliado; não há exemplos.
64. **"Hot wallet":** citado nos critérios (CHALLENGE.md §14 — Concorrência) mas sem definição nem cenário específico em §8/§13.
65. **Ordenação entre operações da mesma wallet:** o enunciado diz que o banco é responsável, mas não define se há alguma ordem desejada (ex.: `WIN` antes de `BET` — ver item 23).

### 8.9 Observabilidade e testes

66. **Métricas:** formato/endpoint de exposição (ex.: Prometheus `/metrics`) não é especificado, só a lista mínima.
67. **O que é "dado sensível":** o enunciado proíbe "dados sensíveis ou payloads financeiros completos nos logs" sem dizer quais campos (ex.: `playerId`? valores?).
68. **Cobertura:** "cobertura de falhas" nos critérios (CHALLENGE.md §14), sem meta numérica de coverage.
69. **Execução dos testes:** o enunciado pede testes de integração com containers reais, mas não diz se a ferramenta de containers deve ser Testcontainers, o próprio Docker Compose ou outra; livre.

### 8.10 Itens de escopo / contexto

70. **TanStack e "experiência de usuário"** aparecem apenas na apresentação da empresa (CHALLENGE.md Intro: "NestJS, Bun, TanStack, DDD"; "experiência de usuário"). Não há requisito de frontend; presumir **sem frontend**, mas vale confirmar.
71. **"Tempo real"** é mencionado só na Intro, sem requisito correspondente (ver 3.8).
72. **Mudança de escopo opcional de moeda:** CHALLENGE.md §6.1 permite assumir só `BRL`; mas exige que conflitos de moeda sejam testados — para isso é necessário ao menos uma segunda moeda no teste, mesmo que o resto assuma `BRL`.
73. **Autenticação:** implementar não dá pontos (CHALLENGE.md §2) e o enunciado manda "dimensionar o timebox"; decisão do candidato implementar ou não — mas se não implementar, é obrigatório documentar e deixar um ponto de extensão explícito no código.
