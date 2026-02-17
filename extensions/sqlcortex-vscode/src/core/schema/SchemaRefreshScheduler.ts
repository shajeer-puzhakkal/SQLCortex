type SchemaRefreshSchedulerOptions = {
  debounceMs?: number;
  refresh: () => Promise<void> | void;
  onError?: (err: unknown) => void;
};

const DEFAULT_DEBOUNCE_MS = 1000;

export class SchemaRefreshScheduler {
  private readonly debounceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pending = false;
  private disposed = false;

  constructor(private readonly options: SchemaRefreshSchedulerOptions) {
    this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  schedule(): void {
    if (this.disposed) {
      return;
    }
    this.pending = true;
    if (this.running) {
      return;
    }
    this.armTimer();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (this.disposed || this.running || !this.pending) {
      return;
    }

    this.running = true;
    this.pending = false;
    try {
      await this.options.refresh();
    } catch (err) {
      this.options.onError?.(err);
    } finally {
      this.running = false;
      if (!this.disposed && this.pending) {
        this.armTimer();
      }
    }
  }
}
