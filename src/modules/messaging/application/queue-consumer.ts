import { Logger } from "@nestjs/common";
import type { FaultInjector } from "../../../shared/application/fault-injector.port";
import type { MessageQueue, QueueMessage } from "./message-queue.port";
import { type VisibilityBackoff, visibilityBackoffSeconds } from "./visibility-backoff";

export type Disposition =
  | { kind: "ack" }
  | { kind: "dead-letter"; reason: string; detail: string }
  | { kind: "retry"; reason: string; detail: string };

export interface MessageHandler {
  handle(message: QueueMessage): Promise<Disposition>;
}

export interface QueueConsumerSettings {
  waitSeconds: number;
  batchSize: number;
  concurrency: number;
  visibilityTimeoutSeconds: number;
  backoff: VisibilityBackoff;
  shutdownTimeoutMs: number;
  pollFailurePauseMs: number;
}

export class QueueConsumer {
  private readonly logger = new Logger(QueueConsumer.name);
  private readonly notStarted = new Set<QueueMessage>();
  private stopped = true;
  private shutdown = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    private readonly queue: MessageQueue,
    private readonly handler: MessageHandler,
    private readonly faults: FaultInjector,
    private readonly settings: QueueConsumerSettings,
  ) {}

  start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.shutdown = new AbortController();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.shutdown.abort();
    await this.release([...this.notStarted]);
    await this.waitForLoop();
  }

  private async waitForLoop(): Promise<void> {
    const loop = this.loop;

    if (!loop) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.settings.shutdownTimeoutMs);
    });

    try {
      if ((await Promise.race([loop, expired])) === "timeout") {
        this.logger.warn(
          `Encerramento excedeu ${this.settings.shutdownTimeoutMs}ms com mensagens em processamento; elas voltam após o visibility timeout`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let messages: QueueMessage[];

      try {
        messages = await this.queue.receive({
          maxMessages: this.settings.batchSize,
          waitSeconds: this.settings.waitSeconds,
          visibilityTimeoutSeconds: this.settings.visibilityTimeoutSeconds,
        });
      } catch (error) {
        if (this.stopped) {
          return;
        }

        this.logger.error(`Falha ao buscar mensagens da fila: ${describe(error)}`);
        await this.pause();
        continue;
      }

      if (this.stopped) {
        await this.releaseAll(messages);
        return;
      }

      await this.handleBatch(messages);
    }
  }

  private async handleBatch(messages: readonly QueueMessage[]): Promise<void> {
    const groups = groupInOrder(messages);
    let next = 0;

    for (const message of messages) {
      this.notStarted.add(message);
    }

    const worker = async (): Promise<void> => {
      while (next < groups.length) {
        const group = groups[next++] as QueueMessage[];
        await this.handleGroup(group);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.settings.concurrency, groups.length) }, worker),
    );
  }

  private async handleGroup(group: readonly QueueMessage[]): Promise<void> {
    for (const [index, message] of group.entries()) {
      if (!this.notStarted.delete(message)) {
        return;
      }

      if (!(await this.process(message))) {
        await this.release(group.slice(index + 1));
        return;
      }
    }
  }

  private async process(message: QueueMessage): Promise<boolean> {
    let disposition: Disposition;

    try {
      disposition = await this.handler.handle(message);
    } catch (error) {
      disposition = { kind: "retry", reason: "HANDLER_FAILURE", detail: describe(error) };
    }

    try {
      switch (disposition.kind) {
        case "ack":
          await this.acknowledge(message);
          return true;
        case "dead-letter":
          await this.deadLetter(message, disposition);
          return true;
        case "retry":
          await this.retryLater(message, disposition);
          return false;
      }
    } catch (error) {
      this.logger.warn({
        event: "consumer.settle_failed",
        disposition: disposition.kind,
        sqsMessageId: message.sqsMessageId,
        error: describe(error),
      });

      return false;
    }
  }

  private async acknowledge(message: QueueMessage): Promise<void> {
    await this.faults.check("consumer.after_commit_before_ack");
    await this.queue.delete(message);
  }

  /**
   * A DLQ FIFO só aceita o envio explícito com grupo e deduplicação. Enviamos primeiro e só
   * depois apagamos da entrada: se o envio falhar, a mensagem não é apagada e volta a ser
   * tentada. O pior caso é uma cópia a mais na DLQ (escondida pela deduplicação do FIFO), nunca
   * uma mensagem perdida.
   */
  private async deadLetter(
    message: QueueMessage,
    disposition: Extract<Disposition, { kind: "dead-letter" }>,
  ): Promise<void> {
    this.reportPermanentFailure(message, disposition);

    await this.queue.sendToDeadLetter(message, disposition.reason);
    await this.queue.delete(message);
  }

  private async retryLater(
    message: QueueMessage,
    disposition: Extract<Disposition, { kind: "retry" }>,
  ): Promise<void> {
    const seconds = visibilityBackoffSeconds(message.receiveCount, this.settings.backoff);

    this.logger.warn({
      event: "consumer.transient_failure",
      reason: disposition.reason,
      detail: disposition.detail,
      sqsMessageId: message.sqsMessageId,
      groupId: message.groupId,
      receiveCount: message.receiveCount,
      retryInSeconds: seconds,
    });

    await this.queue.changeVisibility(message, seconds);
  }

  private reportPermanentFailure(
    message: QueueMessage,
    disposition: Extract<Disposition, { kind: "dead-letter" }>,
  ): void {
    // Ponto da métrica de mensagens enviadas à DLQ (etapa 15).
    this.logger.warn({
      event: "consumer.dead_letter",
      reason: disposition.reason,
      detail: disposition.detail,
      sqsMessageId: message.sqsMessageId,
      groupId: message.groupId,
      receiveCount: message.receiveCount,
    });
  }

  private releaseAll(messages: readonly QueueMessage[]): Promise<void> {
    for (const message of messages) {
      this.notStarted.add(message);
    }

    return this.release(messages);
  }

  private async release(messages: readonly QueueMessage[]): Promise<void> {
    const pending = messages.filter((message) => this.notStarted.delete(message));

    await Promise.all(
      pending.map(async (message) => {
        try {
          await this.queue.changeVisibility(message, 0);
        } catch (error) {
          this.logger.warn({
            event: "consumer.release_failed",
            sqsMessageId: message.sqsMessageId,
            error: describe(error),
          });
        }
      }),
    );
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const { signal } = this.shutdown;
      const timer = setTimeout(done, this.settings.pollFailurePauseMs);

      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }

      signal.addEventListener("abort", done, { once: true });
    });
  }
}

function groupInOrder(messages: readonly QueueMessage[]): QueueMessage[][] {
  const groups = new Map<string, QueueMessage[]>();

  for (const message of messages) {
    const key = message.groupId ?? message.sqsMessageId;
    const group = groups.get(key);

    if (group) {
      group.push(message);
    } else {
      groups.set(key, [message]);
    }
  }

  return [...groups.values()];
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
