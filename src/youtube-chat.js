const EventEmitter = require('events');

const YT_BASE = 'https://www.youtube.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

class YouTubeChat extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map();
  }

  async connect(identifier) {
    if (this.connections.has(identifier)) {
      this.emit('status', { platform: 'youtube', channel: identifier, status: 'already_connected' });
      return;
    }

    let watchUrl;
    if (/^[A-Za-z0-9_-]{11}$/.test(identifier)) {
      watchUrl = `${YT_BASE}/watch?v=${identifier}`;
    } else {
      const handle = identifier.startsWith('@') ? identifier : `@${identifier}`;
      const liveHtml = await fetch(`${YT_BASE}/${handle}/live`, { headers: HEADERS, signal: AbortSignal.timeout(10000) }).then(r => r.text());
      const videoId = liveHtml.match(/"videoId":"([A-Za-z0-9_-]{11})"/)?.[1];
      if (!videoId) throw new Error(`No live stream found for "${identifier}". Make sure you are live.`);
      watchUrl = `${YT_BASE}/watch?v=${videoId}`;
    }

    const watchHtml = await fetch(watchUrl, { headers: HEADERS, signal: AbortSignal.timeout(10000) }).then(r => r.text());

    const apiKey = watchHtml.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1]
                || watchHtml.match(/"innertubeApiKey":"([^"]+)"/)?.[1];
    if (!apiKey) throw new Error('Could not extract YouTube innertubeApiKey from page.');

    const clientVersion = watchHtml.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] || '2.20240101.00.00';

    const continuation = watchHtml.match(/"continuation":"([A-Za-z0-9_\-]{50,})"/)?.[1];
    if (!continuation) throw new Error('Could not find live chat continuation token. Is the stream live?');

    const entry = { timer: null, seenIds: new Set(), continuation, apiKey, clientVersion };
    this.connections.set(identifier, entry);
    this.emit('status', { platform: 'youtube', channel: identifier, status: 'connected' });
    console.log('[youtube] connected, starting poll for', identifier);

    this._poll(identifier);
  }

  async _poll(identifier) {
    const conn = this.connections.get(identifier);
    if (!conn) return;

    try {
      const res = await fetch(
        `${YT_BASE}/youtubei/v1/live_chat/get_live_chat?key=${conn.apiKey}`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(15000),
          headers: { ...HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: {
              client: { clientName: 'WEB', clientVersion: conn.clientVersion, hl: 'en', gl: 'US' },
            },
            continuation: conn.continuation,
          }),
        }
      );

      if (!res.ok) {
        console.error('[youtube] poll HTTP', res.status);
        conn.timer = setTimeout(() => this._poll(identifier), 5000);
        return;
      }

      const data = await res.json();
      const lc = data && data.continuationContents && data.continuationContents.liveChatContinuation;
      const actions = (lc && lc.actions) || [];

      // Extract viewer count from the header if present
      const headerRenderer = lc && lc.header && lc.header.liveChatHeaderRenderer;
      const vcRuns = headerRenderer && headerRenderer.viewerCountText && headerRenderer.viewerCountText.runs;
      if (vcRuns && vcRuns.length > 0) {
        const num = parseInt((vcRuns[0].text || '').replace(/[^0-9]/g, ''), 10);
        if (!isNaN(num)) this.emit('viewers', { platform: 'youtube', channel: identifier, viewers: num });
      }

      const conts = lc && lc.continuations && lc.continuations[0];
      const nextCont = (conts && conts.invalidationContinuationData && conts.invalidationContinuationData.continuation)
                    || (conts && conts.timedContinuationData && conts.timedContinuationData.continuation);
      if (nextCont) conn.continuation = nextCont;

      const pollMs = (conts && conts.timedContinuationData && conts.timedContinuationData.timeoutMs) || 5000;

      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        const item = action && action.addChatItemAction && action.addChatItemAction.item;
        const renderer = (item && item.liveChatTextMessageRenderer) || (item && item.liveChatPaidMessageRenderer);
        if (!renderer) continue;

        const id = renderer.id;
        if (conn.seenIds.has(id)) continue;
        conn.seenIds.add(id);
        if (conn.seenIds.size > 2000) {
          const it = conn.seenIds.values();
          for (let j = 0; j < 500; j++) conn.seenIds.delete(it.next().value);
        }

        const author = (renderer.authorName && renderer.authorName.simpleText) || 'Unknown';
        const runs = (renderer.message && renderer.message.runs) || [];
        const messageParts = [];
        let messageText = '';
        for (const r of runs) {
          if (r.text) {
            messageParts.push({ type: 'text', text: r.text });
            messageText += r.text;
          } else if (r.emoji) {
            const emoji = r.emoji;
            const thumbnails = emoji.image && emoji.image.thumbnails;
            const thumbUrl = thumbnails && thumbnails.length && thumbnails[thumbnails.length - 1].url;
            if (thumbUrl && emoji.isCustomEmoji) {
              const alt = (emoji.shortcuts && emoji.shortcuts[0]) || emoji.emojiId || '';
              messageParts.push({ type: 'emote', url: thumbUrl, alt });
              messageText += alt;
            } else {
              const ch = emoji.emojiId || '';
              messageParts.push({ type: 'text', text: ch });
              messageText += ch;
            }
          }
        }

        const badgeRenderers = renderer.authorBadges || [];
        const badges = badgeRenderers.map(function(b) {
          return (b.liveChatAuthorBadgeRenderer && b.liveChatAuthorBadgeRenderer.tooltip) || '';
        }).filter(Boolean);

        this.emit('message', {
          platform: 'youtube',
          channel: identifier,
          author: author,
          authorColor: '#FF0000',
          message: messageText,
          messageParts: messageParts.some(p => p.type === 'emote') ? messageParts : null,
          badges: badges,
          timestamp: Date.now(),
          id: id,
        });
      }

      const delay = Math.min(Math.max(pollMs, 5000), 10000);
      conn.timer = setTimeout(() => this._poll(identifier), delay);
    } catch (err) {
      console.error('[youtube] poll error:', err.message);
      conn.timer = setTimeout(() => this._poll(identifier), 6000);
    }
  }

  disconnect(identifier) {
    const conn = this.connections.get(identifier);
    if (conn) {
      clearTimeout(conn.timer);
      this.connections.delete(identifier);
      this.emit('status', { platform: 'youtube', channel: identifier, status: 'disconnected' });
    }
  }
}

module.exports = YouTubeChat;