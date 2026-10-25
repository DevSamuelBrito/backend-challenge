# Teste de carga

## 1. Objetivo

Medir o **custo de estar correto** quando várias instâncias da aplicação recebem pedidos ao mesmo tempo, e verificar que a correção financeira se mantém sob essa carga. O experimento mostra:

- vazão e latência quando os pedidos **não disputam** a mesma wallet;
- o que muda quando todos disputam **uma única wallet** (o custo do lock pessimista);
- o custo de uma **tempestade de replays** com a mesma `Idempotency-Key`;
- o comportamento de **reversões que chegam antes da referência** (worker de pendências);
- o atraso da **outbox** (*outbox lag*) e quanto tempo ela leva para esvaziar.

Não existe meta de RPS. O resultado mais importante não é um número de velocidade: é a seção [Verificação de correção](#6-verificação-de-correção). Os números servem para entender **onde está o gargalo**, não para comparar com outros sistemas.

## 2. Ambiente

<!-- load:environment:start -->
| Item | Valor |
| --- | --- |
| Data da execução | 2026-10-25T20:47:52.083Z |
| Sistema operacional do gerador de carga | win32 10.0.19045 (x64) |
| CPU | AMD Ryzen 7 5700X 8-Core Processor (16 núcleos lógicos) |
| Memória do computador | 15.9 GiB |
| Docker / Compose | 29.8.0 / 5.5.1 |
| VM do Docker | 16 CPUs, 7.7 GiB (Docker Desktop (containerized)) |
| Bun (gerador de carga) | 1.4.4 |
| Instâncias da aplicação | 3 |
| PostgreSQL | PostgreSQL 16.15; max_connections=100; shared_buffers=128MB |
| Papéis de cada instância | api, consumer, outbox, pending-worker |
| Pool de conexões | 10 por instância (padrão do driver pg; o projeto não configura) |
| lock_timeout | 5000 ms |
| Publicador da outbox | lote de 10 a cada 1000 ms, por instância |
| Worker de pendências | lote de 20 a cada 1000 ms; 10 tentativas ou 900 s |
| Concorrência do gerador (closed-loop) | 24 trabalhadores |
| Rodadas | 3 |
| Aquecimento | 150 requisições por rodada, descartadas |
| Tamanho dos cenários | 100 wallets × 6 operações; 600 BETs na hot wallet; 2000 replays sobre 5 chaves; 200 pares BET+reversão (30% com a reversão antes da BET) |
<!-- load:environment:end -->

PostgreSQL, LocalStack (SQS) e as 3 instâncias da aplicação rodam em containers **na mesma máquina** do gerador de carga. Isso limita o significado dos números absolutos (ver [Limitações](#4-limitações-e-o-que-estes-números-não-dizem)).

## 3. Metodologia

### Como executar

```bash
docker compose up --build -d --wait --scale app=3
bun run test:load
```

Duração aproximada: 6 a 7 minutos (3 rodadas). O comando pode ser reexecutado sem limpar nada: todos os ids (jogadores, wallets, transações) levam um identificador único da execução. Para começar de um banco vazio: `docker compose down -v` e subir de novo.

### Modelo de carga

- **Closed-loop (concorrência fixa).** O gerador usa N trabalhadores (padrão 24). Cada um envia um pedido e só envia o próximo depois de receber a resposta. As requisições são distribuídas **em rodízio** entre as 3 instâncias, por `127.0.0.1` e a porta publicada de cada uma.
- **Aquecimento descartado.** Antes dos cenários de cada rodada, 150 BETs em 3 wallets descartáveis aquecem conexões e o JIT. Essas medições são jogadas fora.
- **Preparação fora da medição.** A criação das wallets de cada cenário acontece antes de o relógio começar, e a outbox é esvaziada antes de cada cenário, para que o *lag* medido seja só o do próprio cenário.
- **3 rodadas.** Cada rodada executa os 4 cenários. Os resultados mostram **mediana (mín–máx)** das 3 rodadas.

### Cenários

| # | Cenário | O que faz | Disputa |
|---|---|---|---|
| 1 | Wallets distintas | 100 wallets, cada uma com 6 operações em sequência (BET, WIN, BET, LOSS, BET, REFUND) | Nenhuma: cada pedido tranca só a própria wallet |
| 2 | Hot wallet | 1 wallet com saldo alto recebe 600 BETs de 1.00 de todos os trabalhadores | Total: todos disputam o mesmo `FOR UPDATE` |
| 3 | Tempestade de replays | 5 BETs, cada uma reenviada ~400 vezes em paralelo com a mesma `Idempotency-Key` e o mesmo corpo (2000 requisições) | Moderada: 5 wallets, só leituras depois do primeiro efeito |
| 4 | Misto com reversões | 200 pares BET + REFUND/ROLLBACK em 10 wallets; 30% dos pares enviam a reversão **antes** da BET (resposta 202, resolvida pelo worker) | Moderada: ~2,4 trabalhadores por wallet |

### O que é medido

Por cenário: total de requisições, duração, vazão, latência p50/p95/p99/máx (percentil por *nearest-rank* sobre todas as amostras, ver [stats.ts](../test/load/stats.ts)), contagem por status HTTP, erros técnicos (5xx, 503 e timeout) separados das rejeições de negócio esperadas (422) e dos conflitos (409), espera pelo lock da wallet e *lock timeouts* (diferença dos contadores de `/metrics` das 3 instâncias, antes e depois), latência do lado do servidor, pico do `wager_outbox_lag_seconds` durante a carga e o tempo até a outbox voltar a 0.

### Verificação de correção (ao final de cada cenário, em cada rodada)

1. As pendências foram resolvidas (nenhuma `PENDING`/`PENDING_REFERENCE`).
2. A outbox drenou (nenhum evento sem publicar).
3. `POST /wallets/:id/reconciliation` devolveu `consistent: true` para **todas** as wallets do cenário.
4. Consulta direta ao banco: nenhum saldo negativo.
5. O saldo final é igual ao **saldo esperado, calculado a priori** a partir das operações enviadas.
6. O saldo da wallet é igual à soma recalculada do ledger (SQL direto, independente do endpoint).
7. O número de transações gravadas é o esperado (nenhuma duplicada, nenhuma perdida) e todas estão `PROCESSED`.
8. Cada efeito financeiro tem exatamente um lançamento no ledger.
9. Nenhuma transação externa tem mais de um efeito.
10. Existe um `WalletBalanceChanged` na outbox para cada lançamento do ledger.

Se qualquer verificação falha, o comando sai com código 1 e imprime o diagnóstico. Código 2 indica falha de preparação (por exemplo, menos de 3 instâncias).

## 4. Limitações e o que estes números não dizem

- **Coordinated omission.** O modelo closed-loop espera a resposta antes de enviar o próximo pedido. Se o sistema ficar lento por um instante, os trabalhadores também ficam lentos e **deixam de gerar justamente os pedidos que teriam esperado**. A latência medida fica, por construção, **otimista** em relação à de um cliente real que chega a uma taxa independente do servidor. Um modelo *open-loop* (chegadas a taxa fixa) corrigiria isso e não foi feito.
- **Gerador e sistema na mesma máquina.** O gerador de carga, o PostgreSQL, o LocalStack e as 3 instâncias disputam as mesmas CPUs, memória e rede de uma máquina de desenvolvimento rodando Docker Desktop. Parte da latência medida é a disputa entre o gerador e o sistema. Os números absolutos **não** se transferem para outro ambiente.
- **Cenários curtos.** Cada cenário dura de menos de 1 segundo a poucos segundos (o tamanho é limitado pelo tempo que a outbox leva para esvaziar, ver análise). Com 200 a 2000 amostras por cenário, o p99 é determinado por poucas amostras e oscila entre rodadas. Por isso mostramos a faixa mín–máx.
- **Só HTTP.** O experimento não exercita a entrada pela fila SQS.
- **Uma única configuração.** Concorrência, tamanho do pool, `lock_timeout` e intervalos dos workers ficam nos padrões. Nada foi variado para achar um ponto ótimo.
- **Percentis do servidor** vêm de histogramas do Prometheus e têm a resolução dos *buckets* (o limite superior do bucket onde o percentil cai).

## 5. Resultados

<!-- load:results:start -->
Cada célula mostra **mediana (mín–máx)** das 3 rodada(s). Latências em milissegundos medidas no gerador de carga (do envio ao fim da resposta).

#### Vazão e latência

| Cenário | Requisições | Duração (s) | Vazão (req/s) | p50 | p95 | p99 | máx |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Wallets distintas (sem disputa) | 600 | 0.7 (0.6–0.7) | 906 (813–941) | 23 (21–26) | 47 (46–51) | 63 (56–67) | 77 (71–92) |
| Hot wallet (uma wallet, muita concorrência) | 600 | 2.9 (2.5–2.9) | 208 (206–238) | 112 (96–114) | 149 (129–152) | 181 (160–204) | 194 (181–238) |
| Tempestade de replays (mesma Idempotency-Key) | 2,000 | 1.4 | 1,469 (1,409–1,475) | 16 (12–16) | 33 (32–43) | 45 (45–57) | 66 (59–72) |
| Misto com reversões (algumas antes da referência) | 400 | 0.4 | 921 (920–942) | 23 (22–23) | 47 (45–47) | 61 (58–65) | 78 (70–84) |

#### Status HTTP e erros

| Cenário | HTTP 200 | HTTP 202 | Erros técnicos (5xx, 503, timeout) |
| --- | --- | --- | --- |
| Wallets distintas (sem disputa) | 600 | 0 | 0 |
| Hot wallet (uma wallet, muita concorrência) | 600 | 0 | 0 |
| Tempestade de replays (mesma Idempotency-Key) | 2,000 | 0 | 0 |
| Misto com reversões (algumas antes da referência) | 340 | 60 | 0 |

#### Disputa de lock da wallet (somada nas instâncias, lida em `/metrics` antes e depois)

| Cenário | Aquisições do lock | Espera média (ms) | Espera p95 (ms) | Espera p99 (ms) | Lock timeouts | Servidor p95 (ms) | Servidor p99 (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Wallets distintas (sem disputa) | 600 | 1.8 (1.7–2.1) | ≤ 5 | ≤ 10 | 0 | ≤ 50 | ≤ 100 (50–100) |
| Hot wallet (uma wallet, muita concorrência) | 600 | 107.4 (92.9–108.1) | ≤ 250 | ≤ 250 | 0 | ≤ 250 | ≤ 250 |
| Tempestade de replays (mesma Idempotency-Key) | 2,000 | 11.3 (11.2–11.7) | ≤ 50 (25–50) | ≤ 50 | 0 | ≤ 50 | ≤ 50 (50–100) |
| Misto com reversões (algumas antes da referência) | 400 | 12.5 (11.9–12.7) | ≤ 50 | ≤ 50 | 0 | ≤ 50 | ≤ 100 |

Os percentis do histograma do servidor têm a resolução dos *buckets* do Prometheus (`≤ X` é o limite superior do bucket onde o percentil cai).

#### Outbox

| Cenário | Pico do lag (s) | Eventos pendentes ao fim da carga | Tempo até drenar (s) | Vazão de drenagem (eventos/s) |
| --- | --- | --- | --- | --- |
| Wallets distintas (sem disputa) | 35.8 (35.8–35.9) | 1,090 (1,080–1,100) | 36.8 (36.5–36.8) | 29.6 (29.6–29.9) |
| Hot wallet (uma wallet, muita concorrência) | 37.3 (36.5–38.2) | 1,120 (1,110–1,120) | 37.5 (37.5–39.6) | 29.6 (28.3–29.8) |
| Tempestade de replays (mesma Idempotency-Key) | 0.7 (0.6–13.4) | 0 | 0.0 | 0.0 |
| Misto com reversões (algumas antes da referência) | 25.6 (25.5–25.6) | 730 (730–740) | 29.0 (28.7–29.0) | 25.2 (25.2–25.7) |

#### Reversões que chegaram antes da referência (202 → resolvida pelo worker)

| Cenário | Reversões em 202 | Resolução p50 (s) | Resolução máx (s) |
| --- | --- | --- | --- |
| Misto com reversões (algumas antes da referência) | 60 | 2.38 (2.38–2.44) | 3.48 (3.45–3.51) |
<!-- load:results:end -->

## 6. Verificação de correção

<!-- load:correctness:start -->
**Todas as 120 verificações passaram** (12 execuções de cenário).

| Cenário | Verificações aprovadas | Verificações reprovadas |
| --- | --- | --- |
| Wallets distintas (sem disputa) | 30 | 0 |
| Hot wallet (uma wallet, muita concorrência) | 30 | 0 |
| Tempestade de replays (mesma Idempotency-Key) | 30 | 0 |
| Misto com reversões (algumas antes da referência) | 30 | 0 |

Verificações feitas ao final de cada cenário, em cada rodada:

- pendências resolvidas (nenhuma PENDING/PENDING_REFERENCE)
- outbox drenou (nenhum evento sem publicar)
- reconciliação (POST /wallets/:id/reconciliation) consistente em todas as wallets
- nenhum saldo negativo
- saldo final igual ao esperado calculado a priori
- saldo da wallet igual à soma recalculada do ledger (SQL direto)
- transações gravadas = esperado (nenhuma duplicada, nenhuma perdida)
- cada efeito financeiro tem exatamente um lançamento no ledger
- no máximo um efeito por transação externa
- um WalletBalanceChanged na outbox para cada lançamento do ledger
<!-- load:correctness:end -->

## 7. Análise

As tabelas acima são regeneradas a cada execução. **Esta análise foi escrita a partir da execução de 2026-10-25** (as medianas citadas são as das tabelas dessa execução). Reexecutar muda os números e deixa o texto desatualizado nos valores exatos, não nas conclusões qualitativas.

### 7.1 O que os números mostram

**Correção sob carga: nenhuma violação.** Foram 12 execuções de cenário (4 cenários × 3 rodadas) com 10 verificações cada, e todas passaram: saldo esperado igual ao real, nenhum saldo negativo, ledger e saldo batendo, um único efeito por transação externa, outbox completa. Também não houve nenhum erro técnico (5xx, 503 ou timeout) nem *lock timeout*.

**Wallets distintas × hot wallet.** É o contraste principal do experimento:

| | Wallets distintas | Hot wallet | Razão |
|---|---|---|---|
| Vazão (req/s) | 906 | 208 | ÷ 4,4 |
| p50 (ms) | 23 | 112 | × 4,9 |
| p99 (ms) | 63 | 181 | × 2,9 |
| Espera média pelo lock (ms) | 1,8 | 107 | × 60 |

Na hot wallet quase toda a latência é **fila para o lock**: a espera média (107 ms) é cerca de 95% do p50 (112 ms). A conta bate com a Lei de Little: 24 trabalhadores ÷ 208 req/s ≈ 115 ms por pedido. Como as transações da mesma wallet são executadas uma por vez, a vazão da hot wallet fica limitada por `1 ÷ tempo que cada transação segura o lock` (inserir a transação, o lançamento do ledger e os dois eventos da outbox, atualizar a wallet e fazer o commit). Com 24 trabalhadores isso dá 1 ÷ 208 req/s = 4,8 ms, mas **esse valor é só um limite superior**: uma medição avulsa (fora do `test:load`, uma única execução) com 120 trabalhadores sobre a mesma wallet chegou a ~316 req/s, o que implica no máximo ~3,2 ms por transação dentro do lock. Parte do ciclo de cada pedido (HTTP, ORM, aquisição da conexão) acontece fora do lock e, com poucos trabalhadores, deixa o lock ocioso. O que importa é a forma do custo: é um teto **por wallet**, e subir mais instâncias não aumenta a vazão de uma única wallet, só aumenta a fila.

Com wallets distintas o lock não atrapalha: a "espera" média de 1,8 ms é essencialmente o tempo do próprio `SELECT ... FOR UPDATE` (a métrica `wager_wallet_lock_wait_seconds` mede a consulta que adquire o lock, não só a espera por outra transação).

**Tempestade de replays.** 2000 requisições sobre 5 chaves produziram exatamente 5 efeitos (confirmado no banco), todas com resposta 200 (nenhum 409 nem erro), a 1.469 req/s. É mais rápido que o caminho com escrita (906 req/s) porque o replay não insere nada. Mas o código **toma o lock da wallet antes de procurar a transação já conhecida**, então replays da mesma wallet também se enfileiram (espera média de 11 ms contra 1,8 ms nas wallets distintas, com 24 trabalhadores sobre 5 wallets). O cenário usa 5 wallets; uma tempestade sobre **uma** wallet ficaria limitada pelo lock, mas isso não foi medido.

**Reversões antes da referência.** Das 400 requisições, 60 foram reversões enviadas antes da BET e receberam `202`. As 60 viraram `PROCESSED`, com resolução de **2,4 s (p50) e 3,5 s (máx)**. Esse tempo é determinado pela agenda do worker (verificação a cada 1 s e *backoff* começando em 1 s), não pela chegada da BET, que acontece em milissegundos.

**Outbox: o gargalo mais claro do experimento.** A API aceitou entre 200 e 900 req/s, cada efeito gerando 1 a 2 eventos, mas a outbox publica **cerca de 30 eventos/s** (3 instâncias × lote de 10 por verificação de 1 s). Ao fim de uma carga de 600 requisições havia ~1.100 eventos pendentes, o *lag* chegou a 25–38 s e a outbox levou 29–40 s para esvaziar. Nenhum evento se perdeu (as verificações de outbox passaram em todas as execuções): a consistência eventual funciona, mas com a configuração padrão a entrega de eventos é muito mais lenta que o processamento. Por aritmética (não medido em carga longa), sob carga sustentada acima de ~15 transações/s com efeito o *lag* cresceria sem limite. Os parâmetros existem (`OUTBOX_BATCH_SIZE`, `OUTBOX_INTERVAL_MS`), mas outros valores não foram testados.

**Dois detalhes de medição.** (1) O pico de *lag* de 13,4 s no cenário de replays de uma das rodadas, com a outbox vazia, é uma leitura residual: o gauge só é atualizado quando cada instância executa seu ciclo, então logo depois de esvaziar ele ainda pode mostrar o valor do ciclo anterior. A mediana (0,7 s) representa o cenário. (2) A rodada 1 foi um pouco mais lenta nas wallets distintas (813 req/s contra 906 e 941), compatível com o sistema ainda se aquecendo mesmo depois da fase de aquecimento.

### 7.2 Onde está o gargalo

- **Dentro de uma wallet:** o lock pessimista (a latência é quase toda fila para o lock; o teto fica em algumas centenas de req/s por wallet, ~208 req/s com 24 trabalhadores e ~316 req/s numa medição avulsa com 120). Está demonstrado pelos números.
- **Entre wallets:** **não identifiquei**. O sistema fez ~900 req/s com 24 trabalhadores, bem abaixo do que o tempo de lock por transação permitiria se as wallets fossem o único limite. O limite pode estar no PostgreSQL (commit), na CPU compartilhada entre gerador, 3 aplicações, banco e LocalStack, nos logs JSON por requisição ou no ORM. Não fiz profiling, então não afirmo qual.
- **Entrega de eventos:** a configuração padrão da outbox, como descrito acima.

Por que não vimos 503: o pool tem 10 conexões por instância, ou 30 no total (numa medição avulsa com 120 trabalhadores sobre uma wallet, o banco chegou a 30 conexões ativas e nunca passou disso). Isso limita a fila **dentro do banco** a cerca de 30 transações; 30 × 4,8 ms ≈ 144 ms, muito abaixo do `lock_timeout` de 5 s. O excesso de trabalhadores espera por uma conexão do pool, não pelo lock. A conclusão de que o `lock_timeout` dificilmente é atingido por HTTP nestas condições é uma **inferência**; não foi provocada. O comportamento do pool esgotado (espera por conexão, sem erro) é outro modo de degradação, observado só nessa medição avulsa.

### 7.3 O que estes números NÃO podem afirmar

- Que o sistema "aguenta" X req/s em produção. Gerador e sistema dividem a máquina, e a latência é otimista (coordinated omission).
- Escalabilidade com o número de instâncias: só 3 foram usadas, e nada foi variado.
- Comportamento em carga longa: cada cenário dura de 0,4 a 3 s. Vazamentos, crescimento de tabelas, *vacuum* e estabilidade do p99 não foram observados.
- Qual componente limita a vazão entre wallets distintas (ver 7.2).
- O caminho pela fila SQS e a recuperação após falhas sob carga. Esses pontos têm testes próprios de correção (`test:concurrency`), mas não de desempenho.
- Que o p99 seja estável: ele sai de 200 a 2000 amostras e varia entre rodadas (ver as faixas).

### 7.4 Achados

1. **Capacidade da outbox (documentado, não corrigido).** Com a configuração padrão a outbox publica ~30 eventos/s, muito abaixo da vazão da API. Não é erro de correção (nada se perde), é um limite de capacidade e de atraso da entrega eventual.
2. **Replay toma o lock da wallet.** Não há *fast path* sem lock para replays; o plano já listava isso como corte possível. Impacto medido: pequeno (11 ms de espera média sobre 5 wallets).
3. **A métrica de espera do lock inclui a própria consulta** (~2 ms sem disputa), então ela não é "tempo bloqueado por outra transação" puro.
4. **Gauge de *lag* da outbox pode ficar defasado até um ciclo** depois de a fila esvaziar.
5. Nenhum problema de correção, nenhum 5xx e nenhum *lock timeout* foram encontrados. O código de produção não foi alterado.
