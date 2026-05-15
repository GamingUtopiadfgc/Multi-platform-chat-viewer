const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatAPI', {
  // Twitch
  connectTwitch:    (channel)    => ipcRenderer.invoke('twitch:connect', channel),
  disconnectTwitch: (channel)    => ipcRenderer.invoke('twitch:disconnect', channel),

  // YouTube
  connectYouTube:    (identifier) => ipcRenderer.invoke('youtube:connect', identifier),
  disconnectYouTube: (identifier) => ipcRenderer.invoke('youtube:disconnect', identifier),

  // TikTok
  connectTikTok:    (username)   => ipcRenderer.invoke('tiktok:connect', username),
  disconnectTikTok: (username)   => ipcRenderer.invoke('tiktok:disconnect', username),

  // Kick
  connectKick:    (channel) => ipcRenderer.invoke('kick:connect', channel),
  disconnectKick: (channel) => ipcRenderer.invoke('kick:disconnect', channel),

  // Persistence
  loadChannels: () => ipcRenderer.invoke('channels:load'),

  // Debug
  testMessage: (platform) => ipcRenderer.invoke('debug:testMessage', platform),

  // Events from main → renderer
  onMessage: (cb) => ipcRenderer.on('chat:message', (_, msg)    => cb(msg)),
  onStatus:  (cb) => ipcRenderer.on('chat:status',  (_, status) => cb(status)),
  onError:   (cb) => ipcRenderer.on('chat:error',   (_, err)    => cb(err)),
  onViewers: (cb) => ipcRenderer.on('chat:viewers', (_, data)   => cb(data)),

  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('chat:message');
    ipcRenderer.removeAllListeners('chat:status');
    ipcRenderer.removeAllListeners('chat:error');
    ipcRenderer.removeAllListeners('chat:viewers');
  },

  // Auto-update
  onUpdateReady:  (cb) => ipcRenderer.on('app:update-ready', cb),
  installUpdate:  ()   => ipcRenderer.send('app:install-update'),
});
