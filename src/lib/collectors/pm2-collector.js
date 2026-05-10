import { execFile } from 'node:child_process';

export class PM2Collector {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this._cache = null;
    this._timer = null;
    this._onUpdate = null;
  }

  async collect() {
    try {
      const raw = await this._execPm2Jlist();
      const processes = JSON.parse(raw);
      const now = new Date().toISOString();
      const collectedAt = Date.now();

      for (const proc of processes) {
        const name = proc.name;
        const env = proc.pm2_env || {};
        const monit = proc.monit || {};

        this.store.insertMetric({
          timestamp: now,
          runtime: this.config.runtime || 'claude',
          metric_name: 'pm2_status',
          metric_value: env.status === 'online' ? 1 : 0,
          dimensions: { process: name, status: env.status },
          source: 'pm2',
          confidence: 'actual'
        });

        this.store.insertMetric({
          timestamp: now,
          runtime: this.config.runtime || 'claude',
          metric_name: 'pm2_memory',
          metric_value: monit.memory || 0,
          dimensions: { process: name },
          source: 'pm2',
          confidence: 'actual'
        });

        this.store.insertMetric({
          timestamp: now,
          runtime: this.config.runtime || 'claude',
          metric_name: 'pm2_cpu',
          metric_value: monit.cpu || 0,
          dimensions: { process: name },
          source: 'pm2',
          confidence: 'actual'
        });

        this.store.insertMetric({
          timestamp: now,
          runtime: this.config.runtime || 'claude',
          metric_name: 'pm2_restarts',
          metric_value: env.restart_time || 0,
          dimensions: { process: name },
          source: 'pm2',
          confidence: 'actual'
        });

        this.store.insertMetric({
          timestamp: now,
          runtime: this.config.runtime || 'claude',
          metric_name: 'pm2_uptime',
          metric_value: env.pm_uptime ? Date.now() - env.pm_uptime : 0,
          dimensions: { process: name },
          source: 'pm2',
          confidence: 'actual'
        });
      }

      this._cache = { processes, collectedAt };

      this.store.upsertSourceHealth('pm2_reader', 'collector_liveness', 'healthy', {
        last_success: now,
        process_count: processes.length
      });

      if (this._onUpdate) this._onUpdate(this._cache);
    } catch (err) {
      process.stderr.write(`[pm2-collector] Error: ${err.message}\n`);
      this.store.upsertSourceHealth('pm2_reader', 'collector_liveness', 'degraded', {
        error: err.message,
        last_error: new Date().toISOString()
      });
    }
  }

  getLatestPM2Data() {
    return this._cache;
  }

  start(intervalMs = 15_000) {
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

  _execPm2Jlist() {
    return new Promise((resolve, reject) => {
      execFile('pm2', ['jlist'], { timeout: 10_000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });
  }
}
