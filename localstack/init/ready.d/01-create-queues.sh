#!/bin/bash
# Cria as filas do desafio. Idempotente (create-queue com os mesmos atributos é no-op).
#
#   wager-transactions.fifo      entrada de transações (consumidor)
#   wager-transactions-dlq.fifo  DLQ da fila de entrada (redrive após MAX_RECEIVE_COUNT recebimentos)
#   wager-events.fifo            eventos publicados pela outbox (D2 do plan.md)
set -euo pipefail

MAX_RECEIVE_COUNT="${MAX_RECEIVE_COUNT:-5}"
ATTRS_FILE="$(mktemp)"
trap 'rm -f "$ATTRS_FILE"' EXIT

awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,VisibilityTimeout=30 \
  >/dev/null

DLQ_URL="$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo \
  --query QueueUrl --output text)"
DLQ_ARN="$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)"

# RedrivePolicy é uma string JSON dentro do JSON de atributos.
cat >"$ATTRS_FILE" <<EOF
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "30",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"${MAX_RECEIVE_COUNT}\"}"
}
EOF
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "file://${ATTRS_FILE}" \
  >/dev/null

awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,VisibilityTimeout=30 \
  >/dev/null

echo "Filas criadas:"
awslocal sqs list-queues
