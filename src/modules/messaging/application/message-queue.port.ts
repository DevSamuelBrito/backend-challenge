export const MESSAGE_QUEUE = Symbol("MESSAGE_QUEUE");

export interface QueueMessage {
  sqsMessageId: string;
  receiptHandle: string;
  body: string;
  groupId: string | undefined;
  deduplicationId: string | undefined;
  receiveCount: number;
}

export interface ReceiveOptions {
  maxMessages: number;
  waitSeconds: number;
  visibilityTimeoutSeconds: number;
}

export interface MessageQueue {
  receive(options: ReceiveOptions): Promise<QueueMessage[]>;
  delete(message: QueueMessage): Promise<void>;
  changeVisibility(message: QueueMessage, seconds: number): Promise<void>;
  sendToDeadLetter(message: QueueMessage, reason: string): Promise<void>;
}
