const EventEmitter = require('events');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const PUSHER_APP_KEY = '32cbd69e4b950bf97679';
const PUSHER_CLUSTER = 'us2';

// Persistent cache of slug → chatroomId so we don't need to re-fetch
function getCacheFile() {
  return path.join(app.getPath('userData'), 'kick-chatrooms.json');
}
function loadCache() {
  try { return JSON.parse(fs.readFileSync(getCacheFile(), 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  try { fs.writeFileSync(getCacheFile(), JSON.stringify(cache, null, 2), 'utf8'); } catch { /* ignore */ }
}

class KickChat extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map(); // slug → { ws, pingTimer }
  }

  async _fetchChatroomId(slug) {
    // Check persistent cache first
    const cache = loadCache();
    if (cache[slug]) return cache[slug];

    // Try API v2 first; fall back to scraping the channel page if blocked
    const apiUrl = `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`;
    const pageUrl = `https://kick.com/${encodeURIComponent(slug)}`;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://kick.com/',
    };

    // Try API
    try {
      const res = await fetch(apiUrl, {
        signal: AbortSignal.timeout(8000),
        headers: { ...headers, Accept: 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        const id = data && data.chatroom && data.chatroom.id;
        if (id) { cache[slug] = id; saveCache(cache); return id; }
      }
    } catch { /* fall through to page scrape */ }

    // Scrape channel page for chatroom ID
    const pageRes = await fetch(pageUrl, { signal: AbortSignal.timeout(10000), headers });
    if (!pageRes.ok) throw new Error(`Kick channel "${slug}" not found (HTTP ${pageRes.status})`);
    const html = await pageRes.text();

    // Look for chatroomId in the page data
    const m = html.match(/"chatroom":\s*\{[^}]*"id"\s*:\s*(\d+)/)
           || html.match(/"chatroom_id"\s*:\s*(\d+)/)
           || html.match(/chatrooms\.(\d+)\.v2/);
    if (!m) throw new Error(`Could not find chatroom ID for Kick channel "${slug}" on page`);
    const id = parseInt(m[1], 10);
    cache[slug] = id;
    saveCache(cache);
    return id;
  }

  async connect(channelSlug) {
    const slug = channelSlug.toLowerCase();

    if (this.connections.has(slug)) {
      this.emit('status', { platform: 'kick', channel: slug, status: 'already_connected' });
      return;
    }

    // Mark as pending immediately to prevent duplicate connect calls
    this.connections.set(slug, null);

    let chatroomId;
    try {
      chatroomId = await this._fetchChatroomId(slug);
    } catch (err) {
      this.connections.delete(slug);
      throw err;
    }

    const wsUrl =
      `wss://ws-${PUSHER_CLUSTER}.pusher.com/app/${PUSHER_APP_KEY}` +
      `?protocol=7&client=js&version=8.0.0&flash=false`;

    const ws = new WebSocket(wsUrl, { headers: { Origin: 'https://kick.com' } });
    const entry = { ws, pingTimer: null };
    this.connections.set(slug, entry);

    ws.on('open', () => {
      console.log('[kick] WebSocket open, subscribing to chatrooms.' + chatroomId + '.v2');
      ws.send(JSON.stringify({
        event: 'pusher:subscribe',
        data: { auth: '', channel: `chatrooms.${chatroomId}.v2` },
      }));

      // Keep-alive: respond to server pings and send our own every 60 s
      entry.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
        }
      }, 60_000);
    });

    ws.on('message', (raw) => {
      let packet;
      try { packet = JSON.parse(raw.toString()); } catch { return; }

      switch (packet.event) {
        case 'pusher:connection_established':
          break;

        case 'pusher_internal:subscription_succeeded':
          this.emit('status', { platform: 'kick', channel: slug, status: 'connected' });
          break;

        case 'pusher:ping':
          ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
          break;

        case 'App\\Events\\ChatMessageEvent': {
          let msg;
          try {
            msg = typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data;
          } catch { return; }

          this.emit('message', {
            platform: 'kick',
            channel: slug,
            author: msg.sender?.username ?? 'Unknown',
            authorColor: this._validColor(msg.sender?.identity?.color) ?? '#53FC18',
            message: msg.content ?? '',
            messageParts: this._buildParts(msg.content ?? ''),
            badges: (msg.sender?.identity?.badges ?? []).map((b) => b.type),
            isSubscriber: (msg.sender?.identity?.badges ?? []).some((b) => b.type === 'subscriber'),
            timestamp: Date.now(),
            id: msg.id ?? String(Date.now()),
          });
          break;
        }

        default:
          break;
      }
    });

    ws.on('close', (code, reason) => {
      console.log('[kick] WebSocket closed', code, reason.toString());
      clearInterval(entry.pingTimer);
      this.connections.delete(slug);
      this.emit('status', { platform: 'kick', channel: slug, status: 'disconnected' });
    });

    ws.on('error', (err) => {
      console.error('[kick] WebSocket error:', err.message);
      this.emit('error', { platform: 'kick', channel: slug, error: err.message });
    });
  }

  disconnect(channelSlug) {
    const slug = channelSlug.toLowerCase();
    const entry = this.connections.get(slug);
    if (entry) {
      clearInterval(entry.pingTimer);
      entry.ws.close();
    }
    if (this.connections.has(slug)) {
      this.connections.delete(slug);
      this.emit('status', { platform: 'kick', channel: slug, status: 'disconnected' });
    }
  }

  _validColor(color) {
    return /^#[0-9a-fA-F]{3,8}$/.test(color ?? '') ? color : null;
  }

  _buildParts(content) {
    const regex = /\[emote:(\d+):([^\]]+)\]/g;
    const parts = [];
    let last = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      if (match.index > last) parts.push({ type: 'text', text: content.slice(last, match.index) });
      parts.push({ type: 'emote', url: `https://files.kick.com/emotes/${match[1]}/fullsize`, alt: match[2] });
      last = match.index + match[0].length;
    }
    if (last < content.length) parts.push({ type: 'text', text: content.slice(last) });
    return parts.some(p => p.type === 'emote') ? parts : null;
  }
}

module.exports = KickChat;
