export class SseHub {
  constructor(keepaliveMs = 15_000) {
    this.keepaliveMs = keepaliveMs;
    this.clients = new Set();
    this.keepaliveTimer = null;
    this.sequence = 0;
  }

  addClient(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    this._startKeepalive();
    res.on('close', () => {
      this.clients.delete(res);
      if (this.clients.size === 0) this._stopKeepalive();
    });
  }

  removeClient(res) {
    this.clients.delete(res);
    if (this.clients.size === 0) this._stopKeepalive();
  }

  broadcast(eventType, data) {
    this.sequence += 1;
    const payload = `id: ${this.sequence}\nevent: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  closeAll() {
    this._stopKeepalive();
    for (const res of this.clients) {
      try { res.end(); } catch { /* already closed */ }
    }
    this.clients.clear();
  }

  _startKeepalive() {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => {
      for (const res of this.clients) {
        try {
          res.write(': keepalive\n\n');
        } catch {
          this.clients.delete(res);
        }
      }
    }, this.keepaliveMs);
    this.keepaliveTimer.unref();
  }

  _stopKeepalive() {
    if (!this.keepaliveTimer) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }
}
