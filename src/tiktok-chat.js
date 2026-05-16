const EventEmitter = require('events');

class TikTokChat extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map(); // username → WebcastPushConnection
  }

  async connect(username) {
    const name = username.replace(/^@/, '');

    if (this.connections.has(name)) {
      this.emit('status', { platform: 'tiktok', channel: name, status: 'already_connected' });
      return;
    }

    let WebcastPushConnection;
    try {
      ({ WebcastPushConnection } = require('tiktok-live-connector'));
    } catch {
      throw new Error('tiktok-live-connector module missing — run npm install');
    }

    const conn = new WebcastPushConnection(`@${name}`, {
      processInitialData: true,
      enableWebsocketUpgrade: true,
      requestPollingIntervalMs: 2000,
    });

    conn.on('chat', (data) => {
      this.emit('message', {
        platform: 'tiktok',
        channel: name,
        author: data.nickname || data.uniqueId || 'Unknown',
        authorColor: '#69C9D0',
        message: data.comment,
        badges: [],
        isSubscriber: Array.isArray(data.userBadges) && data.userBadges.length > 0,
        timestamp: Date.now(),
        id: String(data.msgId ?? Date.now()),
        avatar: data.profilePictureUrl,
      });
    });

    conn.on('follow', (data) => {
      this.emit('event', {
        platform: 'tiktok', channel: name,
        type: 'follow',
        user: data.nickname || data.uniqueId || 'Someone',
        timestamp: Date.now(),
      });
    });

    conn.on('subscribe', (data) => {
      this.emit('event', {
        platform: 'tiktok', channel: name,
        type: 'subscribe',
        user: data.nickname || data.uniqueId || 'Someone',
        timestamp: Date.now(),
      });
    });

    conn.on('gift', (data) => {
      // For streaked gifts, only emit when the streak ends
      if (data.giftType === 1 && !data.repeatEnd) return;
      this.emit('event', {
        platform: 'tiktok', channel: name,
        type: 'gift',
        user: data.nickname || data.uniqueId || 'Someone',
        gift: data.giftName || 'Gift',
        count: data.repeatCount || 1,
        timestamp: Date.now(),
      });
    });

    conn.on('share', (data) => {
      this.emit('event', {
        platform: 'tiktok', channel: name,
        type: 'share',
        user: data.nickname || data.uniqueId || 'Someone',
        timestamp: Date.now(),
      });
    });

    conn.on('roomUser', (data) => {
      if (data && typeof data.viewerCount === 'number') {
        this.emit('viewers', { platform: 'tiktok', channel: name, viewers: data.viewerCount });
      }
    });

    conn.on('disconnected', () => {
      this.connections.delete(name);
      this.emit('status', { platform: 'tiktok', channel: name, status: 'disconnected' });
    });

    conn.on('error', (err) => {
      this.emit('error', { platform: 'tiktok', channel: name, error: String(err) });
    });

    await conn.connect();
    this.connections.set(name, conn);
    this.emit('status', { platform: 'tiktok', channel: name, status: 'connected' });
  }

  disconnect(username) {
    const name = username.replace(/^@/, '');
    const conn = this.connections.get(name);
    if (conn) {
      conn.disconnect();
      this.connections.delete(name);
      this.emit('status', { platform: 'tiktok', channel: name, status: 'disconnected' });
    }
  }
}

module.exports = TikTokChat;
