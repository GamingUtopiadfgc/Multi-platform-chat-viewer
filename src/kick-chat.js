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

  async _fetchChannelInfo(slug) {
    const cache = loadCache();
    const cached = cache[slug];
    // Handle legacy cache entries (plain number = chatroomId only)
    if (typeof cached === 'number') return { chatroomId: cached, channelId: null };
    if (cached && typeof cached === 'object' && cached.chatroomId) return cached;

    const apiUrl = `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`;
    const pageUrl = `https://kick.com/${encodeURIComponent(slug)}`;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://kick.com/',
    };

    // Try API — returns both channel ID and chatroom ID
    try {
      const res = await fetch(apiUrl, {
        signal: AbortSignal.timeout(8000),
        headers: { ...headers, Accept: 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        const chatroomId = data && data.chatroom && data.chatroom.id;
        const channelId  = data && data.id;
        if (chatroomId) {
          const info = { chatroomId, channelId: channelId || null };
          cache[slug] = info;
          saveCache(cache);
          return info;
        }
      }
    } catch { /* fall through to page scrape */ }

    // Scrape channel page for chatroom ID (channelId unavailable)
    const pageRes = await fetch(pageUrl, { signal: AbortSignal.timeout(10000), headers });
    if (!pageRes.ok) throw new Error(`Kick channel "${slug}" not found (HTTP ${pageRes.status})`);
    const html = await pageRes.text();

    const m = html.match(/"chatroom":\s*\{[^}]*"id"\s*:\s*(\d+)/)
           || html.match(/"chatroom_id"\s*:\s*(\d+)/)
           || html.match(/chatrooms\.(\d+)\.v2/);
    if (!m) throw new Error(`Could not find chatroom ID for Kick channel "${slug}" on page`);
    const chatroomId = parseInt(m[1], 10);
    const info = { chatroomId, channelId: null };
    cache[slug] = info;
    saveCache(cache);
    return info;
  }

  async _fetchViewers(slug) {
    try {
      const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
        signal: AbortSignal.timeout(8000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'application/json',
        },
      });
      if (!res.ok) return;
      const data = await res.json();
      const viewers = data && data.livestream && data.livestream.viewer_count;
      if (typeof viewers === 'number') {
        this.emit('viewers', { platform: 'kick', channel: slug, viewers });
      }
    } catch { /* ignore */ }
  }

  async connect(channelSlug) {
    const slug = channelSlug.toLowerCase();

    if (this.connections.has(slug)) {
      this.emit('status', { platform: 'kick', channel: slug, status: 'already_connected' });
      return;
    }

    // Mark as pending immediately to prevent duplicate connect calls
    this.connections.set(slug, null);

    let chatroomId, channelId;
    try {
      ({ chatroomId, channelId } = await this._fetchChannelInfo(slug));
    } catch (err) {
      this.connections.delete(slug);
      throw err;
    }

    const wsUrl =
      `wss://ws-${PUSHER_CLUSTER}.pusher.com/app/${PUSHER_APP_KEY}` +
      `?protocol=7&client=js&version=8.0.0&flash=false`;

    const ws = new WebSocket(wsUrl, { headers: { Origin: 'https://kick.com' } });
    const entry = { ws, pingTimer: null, viewerTimer: null, connected: false, chatroomId, channelId };
    this.connections.set(slug, entry);

    ws.on('open', () => {
      console.log('[kick] WebSocket open, subscribing to chatrooms.' + chatroomId + '.v2');
      ws.send(JSON.stringify({
        event: 'pusher:subscribe',
        data: { auth: '', channel: `chatrooms.${chatroomId}.v2` },
      }));

      // Also subscribe to the channel events stream (subscriptions, gifts, follows)
      if (channelId) {
        ws.send(JSON.stringify({
          event: 'pusher:subscribe',
          data: { auth: '', channel: `channel.${channelId}` },
        }));
      }

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
          // Emit connected only once (on first subscription succeeded)
          if (!entry.connected) {
            entry.connected = true;
            this.emit('status', { platform: 'kick', channel: slug, status: 'connected' });
            this._fetchViewers(slug);
            entry.viewerTimer = setInterval(() => this._fetchViewers(slug), 60_000);
          }
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

        case 'App\\Events\\SubscriptionEvent': {
          let sub;
          try { sub = typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data; } catch { return; }
          this.emit('event', {
            platform: 'kick', channel: slug,
            type: 'subscribe',
            user: sub.username || sub.user?.username || 'Someone',
            months: sub.months || null,
            timestamp: Date.now(),
          });
          break;
        }

        case 'App\\Events\\GiftedSubscriptionsEvent': {
          let gift;
          try { gift = typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data; } catch { return; }
          const giftCount = (gift.gifted_usernames && gift.gifted_usernames.length) || gift.quantity || 1;
          this.emit('event', {
            platform: 'kick', channel: slug,
            type: 'gift',
            user: gift.gifter_username || 'Someone',
            count: giftCount,
            timestamp: Date.now(),
          });
          break;
        }

        case 'App\\Events\\FollowersUpdated': {
          let follow;
          try { follow = typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data; } catch { return; }
          if (follow.username) {
            this.emit('event', {
              platform: 'kick', channel: slug,
              type: 'follow',
              user: follow.username,
              timestamp: Date.now(),
            });
          }
          break;
        }

        default:
          break;
      }
    });

    ws.on('close', (code, reason) => {
      console.log('[kick] WebSocket closed', code, reason.toString());
      clearInterval(entry.pingTimer);
      clearInterval(entry.viewerTimer);
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
      clearInterval(entry.viewerTimer);
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
