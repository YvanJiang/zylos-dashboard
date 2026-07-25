export class StatuslineCollector {
  constructor(store) {
    this.store = store;
    this._pollTimer = null;
    this._runtimeInfo = null;
  }

  async collect() {
    const latest = this.store.getLatestMetric('statusline_summary');
    const dimensions = latest?.dimensions || {};

    this._runtimeInfo = latest ? {
      model: dimensions.model || dimensions.model_id || null,
      model_id: dimensions.model_id || null,
      effort: dimensions.effort || null,
      cc_version: dimensions.cc_version || null
    } : null;

    return { written: 0, data: latest };
  }

  start() {
    this.stop();
    this._pollTimer = setInterval(() => {
      this.collect().catch(() => {});
    }, 30_000);
    this._pollTimer.unref?.();
  }

  getRuntimeInfo() {
    return this._runtimeInfo;
  }

  stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }
}
