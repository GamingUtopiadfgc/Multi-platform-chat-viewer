const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const TwitchChat = require('./src/twitch-chat');
const YouTubeChat = require('./src/youtube-chat');
const TikTokChat = require('./src/tiktok-chat');
const KickChat = require('./src/kick-chat');
const store = require('./src/store');

let mainWindow;

const twitchChat = new TwitchChat();
const youtubeChat = new YouTubeChat();
const tiktokChat = new TikTokChat();
const kickChat = new KickChat();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'Chat Viewer',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.argv.includes('--enable-logging')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.webContents.on('render-process-gone', (_, details) => {
    console.error('[main] Renderer process gone:', details.reason, details.exitCode);
  });
  mainWindow.webContents.on('did-fail-load', (_, code, desc) => {
    console.error('[main] Failed to load:', code, desc);
  });
}

function forwardEvents(instance) {
  instance.on('viewers', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat:viewers', data);
    }
  });
  instance.on('event', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat:event', data);
    }
  });
  instance.on('message', (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat:message', msg);
    } else {
      console.warn('[main] mainWindow not ready, dropping message');
    }
  });
  instance.on('status', (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat:status', status);
    }
  });
  instance.on('error', (err) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat:error', err);
    }
  });
}

// debug: inject a fake message from the renderer
ipcMain.handle('debug:testMessage', (_, platform) => {
  const msg = {
    platform: platform || 'twitch',
    channel:  'test',
    author:   'TestUser',
    authorColor: '#9146ff',
    message:  'This is a test message 👋',
    badges:   [],
    timestamp: Date.now(),
    id:       'test-' + Date.now(),
  };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat:message', msg);
  return { success: true };
});

forwardEvents(twitchChat);
forwardEvents(youtubeChat);
forwardEvents(tiktokChat);
forwardEvents(kickChat);

// ── Persistence helpers ──────────────────────────────────────────────────────
function normalizeChannel(platform, channel) {
  if (platform === 'youtube') return channel.replace(/^@/, '');
  return channel.toLowerCase().replace(/^@/, '');
}

function addSaved(platform, channel) {
  const data = store.load();
  if (!data[platform]) data[platform] = [];
  const key = normalizeChannel(platform, channel);
  if (!data[platform].includes(key)) data[platform].push(key);
  store.save(data);
}

function removeSaved(platform, channel) {
  const data = store.load();
  if (!data[platform]) return;
  const key = normalizeChannel(platform, channel);
  data[platform] = data[platform].filter((c) => c !== key);
  store.save(data);
}

// ── Twitch ──────────────────────────────────────────────────────────────────
ipcMain.handle('twitch:connect', async (_, channel) => {
  try {
    await twitchChat.connect(channel);
    addSaved('twitch', channel);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
ipcMain.handle('twitch:disconnect', async (_, channel) => {
  await twitchChat.disconnect(channel);
  removeSaved('twitch', channel);
  return { success: true };
});

// ── YouTube ─────────────────────────────────────────────────────────────────
ipcMain.handle('youtube:connect', async (_, identifier) => {
  try {
    await youtubeChat.connect(identifier);
    addSaved('youtube', identifier);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
ipcMain.handle('youtube:disconnect', async (_, identifier) => {
  await youtubeChat.disconnect(identifier);
  removeSaved('youtube', identifier);
  return { success: true };
});

// ── TikTok ──────────────────────────────────────────────────────────────────
ipcMain.handle('tiktok:connect', async (_, username) => {
  try {
    await tiktokChat.connect(username);
    addSaved('tiktok', username);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
ipcMain.handle('tiktok:disconnect', async (_, username) => {
  await tiktokChat.disconnect(username);
  removeSaved('tiktok', username);
  return { success: true };
});

// ── Kick ─────────────────────────────────────────────────────────────────────
ipcMain.handle('kick:connect', async (_, channel) => {
  try {
    await kickChat.connect(channel);
    addSaved('kick', channel);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
ipcMain.handle('kick:disconnect', async (_, channel) => {
  await kickChat.disconnect(channel);
  removeSaved('kick', channel);
  return { success: true };
});

// ── Load saved channels ───────────────────────────────────────────────────────
ipcMain.handle('channels:load', () => store.load());

// ── Auto-updater ─────────────────────────────────────────────────────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-downloaded', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:update-ready');
  }
});

autoUpdater.on('error', (err) => {
  console.error('[updater]', err.message);
});

ipcMain.on('app:install-update', () => {
  autoUpdater.quitAndInstall();
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  // Check for updates 4 s after launch so the window is fully ready
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
