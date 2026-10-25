export class PeriodicRunner {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly task: () => Promise<void>,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.arm();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;

    await this.running;
  }

  private arm(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.runOnce().finally(() => {
        this.running = undefined;

        if (!this.stopped) {
          this.arm();
        }
      });
    }, this.intervalMs);
  }

  private async runOnce(): Promise<void> {
    try {
      await this.task();
    } catch (error) {
      this.onError(error);
    }
  }
}
