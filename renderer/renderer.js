'use strict';

/* ── Constants ────────────────────────────────────────────────────────────── */
const MAX_MSGS = 500;

const PLATFORM = {
  twitch:  { label: 'TW', name: 'Twitch'  },
  youtube: { label: 'YT', name: 'YouTube' },
  tiktok:  { label: 'TT', name: 'TikTok'  },
  kick:    { label: 'KC', name: 'Kick'    },
};

const MODAL_HINTS = {
  twitch:  'Enter channel name — e.g. <strong>xqc</strong> or <strong>pokimane</strong>',
  youtube: 'Enter handle, channel ID, or live video ID — e.g. <strong>@MrBeast</strong>',
  tiktok:  'Enter the username of someone <em>currently live</em> — e.g. <strong>username</strong>',
  kick:    'Enter channel name — e.g. <strong>xqc</strong>',
};

/* ── State ────────────────────────────────────────────────────────────────── */
let activeFilter   = 'all';
let isPaused       = false;
let totalMsgs      = 0;
let pendingMsgs    = [];

const connected = { twitch: new Map(), youtube: new Map(), tiktok: new Map(), kick: new Map() };

// Per-channel viewer count storage: platform → channelKey → count
const viewerCounts = { twitch: new Map(), youtube: new Map(), tiktok: new Map(), kick: new Map() };

/* ── DOM refs ─────────────────────────────────────────────────────────────── */
const feed       = document.getElementById('chat-feed');
const scrollBtn  = document.getElementById('scroll-btn');
const msgCountEl = document.getElementById('msg-count');
const overlay    = document.getElementById('overlay');
const modalTitle = document.getElementById('modal-title');
const modalDesc  = document.getElementById('modal-desc');
const modalInput = document.getElementById('modal-input');
const modalErr   = document.getElementById('modal-err');
const modalOk    = document.getElementById('modal-ok');
const modalCancel= document.getElementById('modal-cancel');
const pauseChk   = document.getElementById('pause-chk');
const clearBtn   = document.getElementById('clear-btn');
const testBtn    = document.getElementById('test-btn');

// Settings panel elements
const settingsPanel   = document.getElementById('settings-panel');
const settingsToggle  = document.getElementById('settings-toggle');
const ttsToggleChk    = document.getElementById('tts-toggle-chk');
const ttsVoiceSel     = document.getElementById('tts-voice-sel');
const ttsRateSlider   = document.getElementById('tts-rate');
const ttsRateVal      = document.getElementById('tts-rate-val');
const ttsVolSlider    = document.getElementById('tts-vol');
const ttsVolVal       = document.getElementById('tts-vol-val');
const fontSizeRange   = document.getElementById('font-size-range');
const fontSizeVal     = document.getElementById('font-size-val');
const maxMsgsInput    = document.getElementById('max-msgs-input');

let modalPlatform = null;

/* ── Settings panel ───────────────────────────────────────────────────────────────── */
settingsToggle.addEventListener('click', () => {
  settingsPanel.classList.toggle('collapsed');
});

/* ── TTS ─────────────────────────────────────────────────────────────────── */
let ttsEnabled  = false;
let ttsQueue    = [];
let ttsSpeaking = false;

// Populate voice list (voices load async in Chromium)
function populateVoices() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return;
  const prev = ttsVoiceSel.value;
  ttsVoiceSel.innerHTML = '';
  voices.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${v.name} (${v.lang})`;
    if (v.default) opt.selected = true;
    ttsVoiceSel.appendChild(opt);
  });
  if (prev) ttsVoiceSel.value = prev;
}
populateVoices();
window.speechSynthesis.addEventListener('voiceschanged', populateVoices);

ttsToggleChk.addEventListener('change', () => {
  ttsEnabled = ttsToggleChk.checked;
  if (!ttsEnabled) {
    window.speechSynthesis.cancel();
    ttsQueue    = [];
    ttsSpeaking = false;
  }
});

ttsRateSlider.addEventListener('input', () => {
  ttsRateVal.textContent = `${ttsRateSlider.value}x`;
});
ttsVolSlider.addEventListener('input', () => {
  ttsVolVal.textContent = `${Math.round(ttsVolSlider.value * 100)}%`;
});

function ttsClean(raw) {
  // [emote:1579033:emojiAstonished] → "emoji Astonished"
  return raw
    .replace(/\[emote:\d+:([^\]]+)\]/g, (_, name) =>
      name.replace(/([a-z])([A-Z])/g, '$1 $2'))
    .trim();
}

function ttsEnqueue(msg) {
  if (!ttsEnabled) return;
  const chk = document.querySelector(`.tts-plat-chk input[data-platform="${msg.platform}"]`);
  if (chk && !chk.checked) return;
  if (ttsQueue.length >= 4) return;
  const platformName = PLATFORM[msg.platform]?.name || msg.platform;
  const text = `from ${platformName}: ${msg.author}: ${ttsClean(msg.message)}`.slice(0, 220);
  ttsQueue.push(text);
  if (!ttsSpeaking) ttsNext();
}

function ttsNext() {
  if (!ttsQueue.length) { ttsSpeaking = false; return; }
  ttsSpeaking = true;
  const utter = new SpeechSynthesisUtterance(ttsQueue.shift());
  const voices = window.speechSynthesis.getVoices();
  const vi = parseInt(ttsVoiceSel.value, 10);
  if (voices[vi]) utter.voice = voices[vi];
  utter.rate   = parseFloat(ttsRateSlider.value);
  utter.volume = parseFloat(ttsVolSlider.value);
  utter.onend  = ttsNext;
  utter.onerror = ttsNext;
  window.speechSynthesis.speak(utter);
}

/* ── Chat display settings ───────────────────────────────────────────── */
let maxMsgs = MAX_MSGS;

fontSizeRange.addEventListener('input', () => {
  const px = fontSizeRange.value;
  fontSizeVal.textContent = `${px}px`;
  feed.style.fontSize = `${px}px`;
});

maxMsgsInput.addEventListener('change', () => {
  const v = parseInt(maxMsgsInput.value, 10);
  if (v >= 50 && v <= 5000) maxMsgs = v;
  else maxMsgsInput.value = maxMsgs;
});

/* ── Restore saved channels on startup ───────────────────────────────────── */
async function restoreSavedChannels() {
  let saved;
  try { saved = await window.chatAPI.loadChannels(); } catch { return; }

  const tasks = [];
  for (const [platform, channels] of Object.entries(saved)) {
    for (const channel of (channels || [])) {
      addChannelToSidebar(platform, channel);
      let promise;
      switch (platform) {
        case 'twitch':  promise = window.chatAPI.connectTwitch(channel);  break;
        case 'youtube': promise = window.chatAPI.connectYouTube(channel); break;
        case 'tiktok':  promise = window.chatAPI.connectTikTok(channel);  break;
        case 'kick':    promise = window.chatAPI.connectKick(channel);    break;
        default: continue;
      }
      tasks.push(promise.then((result) => {
        if (result && !result.success) {
          const entry = connected[platform] && connected[platform].get(channel.toLowerCase().replace(/^@/, ''));
          if (entry) entry.dot.className = 'ch-dot disconnected';
        }
      }).catch(() => { /* individual reconnect failure — dot stays red */ }));
    }
  }
  await Promise.allSettled(tasks);
}

/* ── Filter tabs ─────────────────────────────────────────────────────────── */
document.querySelectorAll('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    applyFilter();
  });
});

function applyFilter() {
  feed.querySelectorAll('.msg').forEach((el) => {
    el.classList.toggle('hide', activeFilter !== 'all' && el.dataset.platform !== activeFilter);
  });
}

/* ── Pause / clear ───────────────────────────────────────────────────────── */
pauseChk.addEventListener('change', () => {
  isPaused = pauseChk.checked;
  if (!isPaused) {
    pendingMsgs.forEach(renderMsg);
    pendingMsgs = [];
    scrollBtn.classList.add('hidden');
    scrollToBottom();
  }
});

clearBtn.addEventListener('click', () => {
  feed.innerHTML = '';
  totalMsgs   = 0;
  pendingMsgs = [];
  updateCount();
  scrollBtn.classList.add('hidden');
});

testBtn.addEventListener('click', async () => {
  console.log('[renderer] test button clicked');
  await window.chatAPI.testMessage('twitch');
});

/* ── Auto-update banner ───────────────────────────────────────────────── */
const updateBanner     = document.getElementById('update-banner');
const updateInstallBtn = document.getElementById('update-install-btn');
const updateDismissBtn = document.getElementById('update-dismiss-btn');

window.chatAPI.onUpdateReady(() => {
  updateBanner.classList.remove('hidden');
});
updateInstallBtn.addEventListener('click', () => window.chatAPI.installUpdate());
updateDismissBtn.addEventListener('click', () => updateBanner.classList.add('hidden'));

/* ── Scroll-to-bottom ────────────────────────────────────────────────────── */
feed.addEventListener('scroll', () => {
  if (isNearBottom()) scrollBtn.classList.add('hidden');
});

scrollBtn.addEventListener('click', () => {
  scrollToBottom();
  scrollBtn.classList.add('hidden');
});

function isNearBottom() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
}

function scrollToBottom() {
  feed.scrollTop = feed.scrollHeight;
}

/* ── Add-channel buttons → open modal ───────────────────────────────────── */
document.querySelectorAll('.add-btn').forEach((btn) => {
  btn.addEventListener('click', () => openModal(btn.dataset.platform));
});

/* ── Modal ───────────────────────────────────────────────────────────────── */
function openModal(platform) {
  modalPlatform    = platform;
  modalTitle.textContent = `Add ${PLATFORM[platform].name} Channel`;
  modalDesc.innerHTML    = MODAL_HINTS[platform];
  modalInput.value       = '';
  modalInput.placeholder = platform === 'youtube' ? '@handle or video ID' : 'Channel name';
  modalErr.textContent   = '';
  modalOk.disabled       = false;
  modalOk.textContent    = 'Connect';
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => modalInput.focus());
}

function closeModal() {
  overlay.classList.add('hidden');
  modalPlatform = null;
}

modalCancel.addEventListener('click', closeModal);
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
modalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  modalOk.click();
  if (e.key === 'Escape') closeModal();
});

modalOk.addEventListener('click', async () => {
  const value = modalInput.value.trim();
  if (!value) { modalErr.textContent = 'Please enter a channel name.'; return; }

  modalErr.textContent = '';
  modalOk.disabled     = true;
  modalOk.textContent  = 'Connecting…';

  let result;
  try {
    switch (modalPlatform) {
      case 'twitch':  result = await window.chatAPI.connectTwitch(value);  break;
      case 'youtube': result = await window.chatAPI.connectYouTube(value); break;
      case 'tiktok':  result = await window.chatAPI.connectTikTok(value);  break;
      case 'kick':    result = await window.chatAPI.connectKick(value);    break;
    }

    if (result.success) {
      addChannelToSidebar(modalPlatform, value);
      closeModal();
    } else {
      modalErr.textContent = result.error || 'Failed to connect.';
    }
  } catch (err) {
    modalErr.textContent = err.message || 'Failed to connect.';
  }

  modalOk.disabled    = false;
  modalOk.textContent = 'Connect';
});

/* ── Sidebar channel management ──────────────────────────────────────────── */
function addChannelToSidebar(platform, channel) {
  const key = channel.toLowerCase().replace(/^@/, '');
  if (connected[platform].has(key)) return;

  const list = document.getElementById(`${platform}-channels`);
  const item = document.createElement('div');
  item.className = 'channel-item';
  item.dataset.key = key;

  const dot  = document.createElement('span');
  dot.className = 'ch-dot connecting';

  const name = document.createElement('span');
  name.className = 'ch-name';
  name.textContent = channel;

  const rmBtn = document.createElement('button');
  rmBtn.className = 'rm-btn';
  rmBtn.title = 'Disconnect';
  rmBtn.textContent = '×';
  rmBtn.addEventListener('click', () => disconnectChannel(platform, key));

  const viewers = document.createElement('span');
  viewers.className = 'ch-viewers';

  item.append(dot, name, viewers, rmBtn);
  list.appendChild(item);
  connected[platform].set(key, { element: item, dot, viewers });
}

async function disconnectChannel(platform, key) {
  try {
    switch (platform) {
      case 'twitch':  await window.chatAPI.disconnectTwitch(key);  break;
      case 'youtube': await window.chatAPI.disconnectYouTube(key); break;
      case 'tiktok':  await window.chatAPI.disconnectTikTok(key);  break;
      case 'kick':    await window.chatAPI.disconnectKick(key);    break;
    }
  } catch { /* ignore */ }

  const entry = connected[platform].get(key);
  if (entry) entry.element.remove();
  connected[platform].delete(key);
  // Clear viewer count for this channel and refresh bar
  if (viewerCounts[platform]) {
    viewerCounts[platform].delete(key);
    updateViewersBar();
  }
}

/* ── Status & error updates from main ───────────────────────────────────── */
window.chatAPI.onStatus(({ platform, channel, status }) => {
  const key   = channel.toLowerCase().replace(/^@/, '');
  const entry = connected[platform]?.get(key);
  if (!entry) return;
  entry.dot.className = 'ch-dot ' +
    (status === 'connected' ? 'connected' : status === 'disconnected' ? 'disconnected' : 'connecting');
});

window.chatAPI.onError(({ platform, channel }) => {
  const key   = channel.toLowerCase().replace(/^@/, '');
  const entry = connected[platform]?.get(key);
  if (entry) entry.dot.className = 'ch-dot disconnected';
});

window.chatAPI.onViewers(({ platform, channel, viewers }) => {
  const key   = channel.toLowerCase().replace(/^@/, '');
  const entry = connected[platform]?.get(key);
  if (entry && entry.viewers) entry.viewers.textContent = formatViewers(viewers);
  // Update aggregate
  if (viewerCounts[platform]) {
    viewerCounts[platform].set(key, viewers);
    updateViewersBar();
  }
});

function updateViewersBar() {
  let total = 0;
  for (const platform of ['twitch', 'youtube', 'tiktok', 'kick']) {
    const map = viewerCounts[platform];
    const sum = map.size ? [...map.values()].reduce((a, b) => a + b, 0) : null;
    const el  = document.getElementById(`vb-${platform}`);
    if (el) el.textContent = sum !== null ? formatViewers(sum) : '\u2014';
    if (sum !== null) total += sum;
  }
  const hasAny = ['twitch','youtube','tiktok','kick'].some(p => viewerCounts[p].size > 0);
  const totalEl = document.getElementById('vb-total');
  if (totalEl) totalEl.textContent = hasAny ? formatViewers(total) : '\u2014';
}

function formatViewers(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

/* ── Incoming messages ───────────────────────────────────────────────────── */
window.chatAPI.onMessage((msg) => {
  totalMsgs++;
  updateCount();
  ttsEnqueue(msg);

  if (isPaused) {
    pendingMsgs.push(msg);
    scrollBtn.classList.remove('hidden');
    scrollBtn.textContent = `↓ ${pendingMsgs.length} new message${pendingMsgs.length === 1 ? '' : 's'}`;
    return;
  }

  const wasBottom = isNearBottom();
  renderMsg(msg);
  if (wasBottom) scrollToBottom();
  else scrollBtn.classList.remove('hidden');
});

/* ── Incoming platform events (follows, subs, gifts, raids…) ─────────────── */
window.chatAPI.onEvent((evt) => {
  if (isPaused) return; // skip events while paused to avoid clutter
  const wasBottom = isNearBottom();
  renderEvent(evt);
  if (wasBottom) scrollToBottom();
  else scrollBtn.classList.remove('hidden');
});

/* ── Render a single message ─────────────────────────────────────────────── */
function renderMsg(msg) {
  const p    = PLATFORM[msg.platform];
  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const el = document.createElement('div');
  el.className = `msg${activeFilter !== 'all' && activeFilter !== msg.platform ? ' hide' : ''}`;
  el.dataset.platform = msg.platform;

  // Platform badge
  const badge = document.createElement('span');
  badge.className = `msg-badge badge-${msg.platform}`;
  badge.title = `${p.name} › ${esc(msg.channel)}`;
  badge.textContent = p.label;

  // Author
  const author = document.createElement('span');
  author.className = 'msg-author';
  author.style.color = sanitizeColor(msg.authorColor);
  author.textContent = msg.author;

  // Role badges (mod / subscriber / member)
  const roleBadges = document.createElement('span');
  roleBadges.className = 'msg-badges';
  (msg.badges || []).forEach((b) => {
    const s = document.createElement('span');
    s.className = 'role-badge';
    s.textContent = b;
    roleBadges.appendChild(s);
  });
  if (msg.isMod) {
    const s = document.createElement('span');
    s.className = 'role-badge';
    s.textContent = 'mod';
    roleBadges.appendChild(s);
  }

  // Channel name
  const chName = document.createElement('span');
  chName.className = 'msg-channel';
  chName.textContent = msg.channel;

  // Message text
  const text = document.createElement('span');
  text.className = 'msg-text';
  if (msg.messageParts && msg.messageParts.length) {
    for (const part of msg.messageParts) {
      if (part.type === 'emote') {
        const img = document.createElement('img');
        img.src = part.url;
        img.alt = part.alt;
        img.title = part.alt;
        img.className = 'chat-emote';
        text.appendChild(img);
      } else {
        text.appendChild(document.createTextNode(part.text));
      }
    }
  } else {
    text.textContent = msg.message;
  }

  // Time
  const ts = document.createElement('span');
  ts.className = 'msg-time';
  ts.textContent = time;

  el.append(badge, author);
  if (roleBadges.children.length) el.append(roleBadges);
  el.append(chName, text, ts);

  feed.appendChild(el);
  pruneMessages();
}

/* ── Render a platform event (follow / sub / gift / raid …) ─────────────── */
function renderEvent(evt) {
  const p    = PLATFORM[evt.platform];
  const time = new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const el = document.createElement('div');
  el.className = `msg evt evt-${evt.type}${activeFilter !== 'all' && activeFilter !== evt.platform ? ' hide' : ''}`;
  el.dataset.platform = evt.platform;

  const badge = document.createElement('span');
  badge.className = `msg-badge badge-${evt.platform}`;
  badge.title = `${p.name} › ${esc(evt.channel)}`;
  badge.textContent = p.label;

  const evtText = document.createElement('span');
  evtText.className = 'evt-text';
  evtText.innerHTML = buildEventText(evt);

  const chName = document.createElement('span');
  chName.className = 'msg-channel';
  chName.textContent = evt.channel;

  const ts = document.createElement('span');
  ts.className = 'msg-time';
  ts.textContent = time;

  el.append(badge, evtText, chName, ts);
  feed.appendChild(el);
  pruneMessages();
}

function buildEventText(evt) {
  const u = `<strong>${esc(evt.user || 'Someone')}</strong>`;
  switch (evt.type) {
    case 'follow':
      return `<span class="evt-icon">❤</span> ${u} followed`;
    case 'subscribe':
      return `<span class="evt-icon">⭐</span> ${u} subscribed${evt.months ? ` (${evt.months} months)` : ''}`;
    case 'resub':
      return `<span class="evt-icon">⭐</span> ${u} resubscribed${evt.months ? ` (${evt.months} months)` : ''}${evt.message ? `: ${esc(evt.message)}` : ''}`;
    case 'gift':
      if (evt.recipient) return `<span class="evt-icon">🎁</span> ${u} gifted a sub to <strong>${esc(evt.recipient)}</strong>`;
      if (evt.gift)      return `<span class="evt-icon">🎁</span> ${u} sent ${evt.count > 1 ? `${evt.count}× ` : ''}<strong>${esc(evt.gift)}</strong>`;
      return `<span class="evt-icon">🎁</span> ${u} gifted ${evt.count || 1} sub${(evt.count || 1) !== 1 ? 's' : ''}`;
    case 'cheer':
      return `<span class="evt-icon">💎</span> ${u} cheered <strong>${evt.count}</strong> bits${evt.message ? `: ${esc(evt.message)}` : ''}`;
    case 'raid':
      return `<span class="evt-icon">⚡</span> ${u} raided with <strong>${evt.count}</strong> viewers`;
    case 'member':
      return `<span class="evt-icon">🏅</span> ${u} became a member${evt.message ? ` — ${esc(evt.message)}` : ''}`;
    case 'superchat':
      return `<span class="evt-icon">💰</span> ${u} super chatted${evt.amount ? ` <strong>${esc(evt.amount)}</strong>` : ''}${evt.message ? `: ${esc(evt.message)}` : ''}`;
    case 'share':
      return `<span class="evt-icon">↗</span> ${u} shared the stream`;
    default:
      return `<span class="evt-icon">📢</span> ${u} — ${esc(evt.type)}`;
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function pruneMessages() {
  const all = feed.querySelectorAll('.msg');
  if (all.length > maxMsgs) {
    for (let i = 0; i < all.length - maxMsgs; i++) all[i].remove();
  }
}

function updateCount() {
  msgCountEl.textContent = `${totalMsgs.toLocaleString()} message${totalMsgs === 1 ? '' : 's'}`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitizeColor(color) {
  if (/^#[0-9a-fA-F]{3,8}$/.test(color ?? '')) return color;
  if (/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(color ?? '')) return color;
  return '#8888aa';
}

// Kick off on load
restoreSavedChannels();
