export class SseHub {
  constructor(keepaliveMs = 15_000) {
    this.keepaliveMs = keepaliveMs;
    this.clients = new Set();
    this.keepaliveTimer = null;
    this.sequence = 0;
  }

  addClient(res, validator, initialEvents = [], acceptsEvent = null) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write(': connected\n\n');
    const client = { res, validator: validator || null, acceptsEvent };
    for (const { eventType, data } of initialEvents) {
      if (!this._write(client, this._eventPayload(eventType, data))) return false;
    }
    this.clients.add(client);
    this._startKeepalive();
    res.on('close', () => {
      this.clients.delete(client);
      if (this.clients.size === 0) this._stopKeepalive();
    });
    return true;
  }

  removeClient(res) {
    for (const client of this.clients) {
      if (client.res === res) {
        this.clients.delete(client);
        break;
      }
    }
    if (this.clients.size === 0) this._stopKeepalive();
  }

  broadcast(eventType, data) {
    this.sequence += 1;
    const payload = `id: ${this.sequence}\n${this._eventPayload(eventType, data)}`;
    for (const client of this.clients) {
      if (this._evictIfInvalid(client)) continue;
      if (client.acceptsEvent && !client.acceptsEvent(eventType, data)) continue;
      this._write(client, payload);
    }
  }

  closeAll() {
    this._stopKeepalive();
    for (const client of this.clients) {
      try { client.res.end(); } catch { /* already closed */ }
    }
    this.clients.clear();
  }

  _evictIfInvalid(client) {
    if (!client.validator || client.validator()) return false;
    try {
      client.res.write('event: auth_expired\ndata: {}\n\n');
      client.res.end();
    } catch { /* already closed */ }
    this.clients.delete(client);
    return true;
  }

  _eventPayload(eventType, data) {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  _write(client, payload) {
    try {
      if (client.res.write(payload)) return true;
      client.res.end();
    } catch { /* disconnected or closed */ }
    this.clients.delete(client);
    return false;
  }

  _startKeepalive() {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => {
      for (const client of this.clients) {
        if (this._evictIfInvalid(client)) continue;
        this._write(client, ': keepalive\n\n');
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
