const EventEmitter = require('events');
const tmi = require('tmi.js');

class TwitchChat extends EventEmitter {
  constructor() {
    super();
    this.clients = new Map(); // normalizedChannel → { client, viewerTimer }
  }

  async connect(channel) {
    const name = channel.toLowerCase().replace(/^#/, '');

    if (this.clients.has(name)) {
      this.emit('status', { platform: 'twitch', channel: name, status: 'already_connected' });
      return;
    }


    const client = new tmi.Client({
      options: { debug: false, skipUpdatingEmotesets: true },
      channels: [`#${name}`],
    });

    client.on('message', (_ch, tags, message, self) => {
      if (self) return;
      this.emit('message', {
        platform: 'twitch',
        channel: name,
        author: tags['display-name'] || tags.username,
        authorColor: this._validColor(tags.color) || this._hashColor(tags.username),
        message,
        messageParts: this._buildParts(message, tags.emotes),
        badges: Object.keys(tags.badges || {}),
        isMod: !!tags.mod,
        isSubscriber: !!(tags.badges && tags.badges.subscriber),
        timestamp: Date.now(),
        id: tags.id,
      });
    });

    client.on('disconnected', (reason) => {
      this.emit('status', { platform: 'twitch', channel: name, status: 'disconnected', reason });
      this.clients.delete(name);
    });

    await client.connect();
    this._fetchViewers(name);
    const viewerTimer = setInterval(() => this._fetchViewers(name), 60000);
    this.clients.set(name, { client, viewerTimer });
    this.emit('status', { platform: 'twitch', channel: name, status: 'connected' });
  }

  async disconnect(channel) {
    const name = channel.toLowerCase().replace(/^#/, '');
    const entry = this.clients.get(name);
    if (entry) {
      clearInterval(entry.viewerTimer);
      entry.client.removeAllListeners();
      await entry.client.disconnect().catch(() => {});
      this.clients.delete(name);
      this.emit('status', { platform: 'twitch', channel: name, status: 'disconnected' });
    }
  }

  async _fetchViewers(name) {
    try {
      const res = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
        body: JSON.stringify([{ query: `{stream(login:"${name}"){viewersCount}}` }]),
      });
      if (!res.ok) return;
      const data = await res.json();
      const viewers = data[0]?.data?.stream?.viewersCount;
      if (typeof viewers === 'number') {
        this.emit('viewers', { platform: 'twitch', channel: name, viewers });
      }
    } catch { /* ignore */ }
  }

  _validColor(color) {
    return /^#[0-9a-fA-F]{3,8}$/.test(color || '') ? color : null;
  }

  _hashColor(username) {
    const palette = ['#FF4500','#2E8B57','#DAA520','#FF69B4','#5F9EA0','#1E90FF','#FF7F50','#9ACD32'];
    const hash = (username || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return palette[hash % palette.length];
  }

  _buildParts(message, emotes) {
    if (!emotes || Object.keys(emotes).length === 0) return null;
    const replacements = [];
    for (const [emoteId, positions] of Object.entries(emotes)) {
      for (const pos of positions) {
        const [start, end] = pos.split('-').map(Number);
        replacements.push({
          start, end,
          url: `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/1.0`,
          alt: message.slice(start, end + 1),
        });
      }
    }
    replacements.sort((a, b) => a.start - b.start);
    const parts = [];
    let cursor = 0;
    for (const r of replacements) {
      if (r.start > cursor) parts.push({ type: 'text', text: message.slice(cursor, r.start) });
      parts.push({ type: 'emote', url: r.url, alt: r.alt });
      cursor = r.end + 1;
    }
    if (cursor < message.length) parts.push({ type: 'text', text: message.slice(cursor) });
    return parts;
  }
}

module.exports = TwitchChat;
