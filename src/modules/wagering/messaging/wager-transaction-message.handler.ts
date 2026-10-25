import { Injectable } from "@nestjs/common";
import { validCorrelationId } from "../../../shared/application/correlation-id";
import { enrichContext } from "../../../shared/application/request-context";
import { describeError } from "../../../shared/application/safe-error";
import type { QueueMessage } from "../../messaging/application/message-queue.port";
import type { Disposition, MessageHandler } from "../../messaging/application/queue-consumer";
import { ProcessWagerTransaction } from "../application/process-wager-transaction";
import { classifyError } from "./error-classifier";
import {
  parseWagerTransactionMessage,
  WAGER_TRANSACTION_CONSUMER,
} from "./wager-transaction-message";

@Injectable()
export class WagerTransactionMessageHandler implements MessageHandler {
  constructor(private readonly processWagerTransaction: ProcessWagerTransaction) {}

  async handle(message: QueueMessage): Promise<Disposition> {
    try {
      const { messageId, command } = parseWagerTransactionMessage(message.body);

      enrichContext({
        messageId,
        correlationId:
          validCorrelationId(message.attributes?.correlationId) ?? validCorrelationId(messageId),
      });

      await this.processWagerTransaction.execute(command, {
        consumerName: WAGER_TRANSACTION_CONSUMER,
        messageId,
      });

      return { kind: "ack" };
    } catch (error) {
      const detail = describeError(error);
      const classification = classifyError(error);

      return classification.kind === "permanent"
        ? { kind: "dead-letter", reason: classification.reason, detail }
        : { kind: "retry", reason: classification.reason, detail };
    }
  }
}
