# Console de testes (interface web)

Uma página para exercitar a API sem digitar `curl`, em passos guiados. Cada passo explica o que testa e mostra o resultado em português simples, com a resposta técnica disponível em "Ver resposta técnica". É uma ferramenta de apoio: não faz parte da aplicação e não altera nada em `src/`.

## Como abrir

1. Suba a aplicação (na raiz do projeto):

   ```bash
   docker compose up --build -d --wait
   ```

2. Em outro terminal, na raiz do projeto (precisa do Bun e de `bun install`):

   ```bash
   bun run console
   ```

3. Abra **http://localhost:4000** no navegador.

O console descobre sozinho em que porta a aplicação subiu (varre `3000-3009`). Se subir mais instâncias (`--scale app=3`), clique em **Detectar de novo** no topo.

Para parar: `Ctrl+C` no terminal do console e `docker compose down -v` para a aplicação.

## O que tem na tela

- **Cartão do topo:** saldo atual da sua carteira, jogador e código da carteira. O botão "Atualizar saldo" busca o valor no servidor. As carteiras que você cria ficam salvas neste navegador: use **"Trocar para uma carteira que você já criou"** para voltar a uma delas, ou cole o código (`walletId`) de qualquer carteira existente (por exemplo, uma criada por `curl`) e clique em "Usar". Cada carteira lembra a sua última aposta, prêmio e devolução, então os passos 3, 5, 6 e 7 continuam funcionando depois da troca.
- **Menu da esquerda:** os passos. Os que você já fez ficam com o número verde.
- **Histórico técnico (rodapé):** todas as chamadas feitas, com a resposta de cada uma.

## Os passos

| Passo | O que você faz | O que deve acontecer |
|---|---|---|
| 1. Criar carteira | Informe o nome do jogador e clique em "Criar carteira" | Carteira criada com 100.00 BRL |
| 2. Fazer uma aposta | Aposte 30.00 | Processada, saldo 70.00 |
| 3. Repetir a aposta | "Repetir exatamente" | Reconhecida como repetição, **nada cobrado**, saldo continua 70.00 |
| 3. (outro botão) | "Reusar a mesma chave com outro valor" | Recusada (409): a chave já foi usada com outro conteúdo |
| 4. Apostar demais | Aposte 500.00 | Rejeitada por saldo insuficiente, saldo continua igual |
| 5. Receber prêmio | WIN de 50.00 ligado à aposta | Processado, saldo sobe 50.00 |
| 6. Devolver a aposta | REFUND da aposta | Processado, o valor da aposta volta |
| 6. (outro botão) | Devolver de novo | Rejeitada: a aposta só pode ser revertida uma vez |
| 7. Rollback | "Reverter o último movimento do extrato" | Pega o último lançamento da carteira (qualquer origem) e o reverte. BET: o valor volta e o saldo sobe; WIN ou REFUND: o valor sai e o saldo desce (sem saldo, é rejeitado). Se o último movimento já é um ROLLBACK ou a abertura (OPENING), o console avisa que não dá para reverter |
| 7. (botões menores) | "Reverter a aposta do passo 2", "o prêmio do passo 5" ou "a devolução do passo 6" | Revertem especificamente essas transações feitas nos passos |
| 7. (outro botão) | Reverter a mesma transação de novo | Rejeitada: só vale uma reversão por transação (inclusive uma BET que já foi devolvida no passo 6) |
| 7. (demonstração) | "Apostar 10.00 e reverter com ROLLBACK" | Saldo cai 10.00 e volta; o segundo rollback da mesma aposta é rejeitado |
| 8. Extrato e conferência | "Ver extrato" e "Conferir as contas" | Um movimento por linha; as contas fecham |
| 9. Concorrência | Botões A e B, com 20 pedidos | A: 1 cobrada e 19 repetições. B: só as apostas que cabem no saldo são cobradas, as outras são rejeitadas e o saldo nunca fica negativo. Em carteira nova de 100.00 com apostas de 30.00: A deixa 70.00, B deixa 10.00 |
| Avançado | Formulário livre, fila SQS, métricas e health | Para quem quer testar combinações |

No passo 9 você escolhe a carteira: **a sua** (o saldo muda de verdade; o resultado depende do saldo que ela tinha) ou **uma carteira nova de 100.00** (resultado sempre previsível; a sua não é afetada). Marque "Espalhar o teste de concorrência entre as instâncias" (depois de subir `--scale app=3`) para as requisições irem a instâncias diferentes ao mesmo tempo. O resultado esperado é o mesmo, porque quem garante a consistência é o banco.

## Por que existe um servidor do console

A API não aceita chamadas diretas de uma página aberta de outra origem (não há CORS, de propósito: a aplicação não foi alterada). Por isso `console/server.ts` serve a página e repassa as chamadas para a instância escolhida. Ele só aceita destinos em `localhost`, escuta apenas em `127.0.0.1` e também envia a mensagem para a fila SQS no modo Avançado.

| Variável | Padrão | Para quê |
|---|---|---|
| `CONSOLE_PORT` | `4000` | Porta do console |
| `SQS_ENDPOINT` | `http://localhost:4566` | LocalStack (mude se usou outra `LOCALSTACK_PORT`) |
| `SQS_TRANSACTIONS_QUEUE` | `wager-transactions.fifo` | Fila de entrada |

## Se algo não funcionar

| Sintoma | Causa provável |
|---|---|
| "nenhum servidor respondendo em 3000-3009" | A aplicação não subiu. Veja `docker compose ps -a` e `docker compose logs app`. O texto ao lado diz o erro da primeira porta. |
| Erro ao enviar | A instância escolhida parou. Clique em "Detectar de novo". |
| Fila SQS dá erro | LocalStack fora do ar ou em outra porta (`SQS_ENDPOINT`). |
| A porta 4000 está ocupada | `CONSOLE_PORT=4100 bun run console` |
| Os passos dizem "crie uma carteira primeiro" | A carteira salva no navegador não existe mais (por exemplo depois de `down -v`). Crie outra no passo 1. |
