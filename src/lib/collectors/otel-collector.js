export class OTelCollector {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this._timer = null;
  }

  async collect() {
    const now = new Date().toISOString();

    this.store.upsertSourceHealth('otel_reader', 'collector_liveness', 'unavailable', {
      reason: 'stub',
      last_check: now
    });
    this.store.upsertSourceHealth('otel_events', 'runtime_progress', 'unavailable', {
      reason: 'stub',
      last_check: now
    });
  }

  start(intervalMs = 10_000) {
    this.stop();
    this._timer = setInterval(() => this.collect(), intervalMs);
    this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
