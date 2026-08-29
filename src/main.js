const { app, Menu, Tray, shell, dialog, BrowserWindow, nativeImage, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const log = require('electron-log');
const AutoLaunch = require('auto-launch');
const { autoUpdater } = require('electron-updater');
const { startBridge, getBridgeState, stopBridge } = require('./bridge');

const APP_NAME = 'CareID Kiosk';
const BASE_KIOSK_URL = process.env.CAREID_KIOSK_URL || 'https://kiosk.careidtag.com.br';
const SETUP_FILE = path.join(__dirname, 'setup.html');

// --- Config persistence (family code for this totem) ---
function getConfigPath() {
  return path.join(app.getPath('userData'), 'kiosk-config.json');
}
function readConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}
function writeConfig(config) {
  try { fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf8'); } catch {}
}
function clearConfig() {
  try { fs.unlinkSync(getConfigPath()); } catch {}
}
function getKioskUrl() {
  const cfg = readConfig();
  if (cfg?.familyCode) return `${BASE_KIOSK_URL}/presenca/${encodeURIComponent(cfg.familyCode)}`;
  return null;
}

let tray = null;
let kioskWindow = null;
let bridgeHandle = null;
let bridgeState = { serverStarted: false, readerConnected: false, readerName: null, clients: 0 };
let menuRefreshTimer = null;
let kioskRestartTimer = null;
let updateCheckInProgress = false;
let manualUpdateCheck = false;

log.transports.file.level = 'info';
log.transports.console.level = 'info';
autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  log.info('Another CareID Kiosk instance is already running. Exiting duplicate instance.');
  app.quit();
} else {
  app.on('second-instance', () => {
    log.info('Second instance attempted. Focusing existing instance.');
    if (kioskWindow && !kioskWindow.isDestroyed()) kioskWindow.focus();
    tray?.displayBalloon?.({ title: APP_NAME, content: 'O CareID Kiosk já está em execução.' });
  });
}

function getLogPath() {
  return log.transports.file.getFile().path;
}

function openLogs() {
  const logPath = getLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  shell.showItemInFolder(logPath);
}

function createIcon() {
  const preferredIcons = [
    path.join(__dirname, '..', 'assets', 'tray.png'),
    path.join(__dirname, '..', 'assets', 'icon.png')
  ];

  for (const iconPath of preferredIcons) {
    if (fs.existsSync(iconPath)) {
      const image = nativeImage.createFromPath(iconPath);
      if (!image.isEmpty()) return image.resize({ width: 16, height: 16 });
    }
  }

  return nativeImage.createEmpty();
}

function statusLabel() {
  const state = getBridgeState();
  if (!state.serverStarted) return 'Bridge parado';
  if (!state.readerConnected) return 'Bridge ativo, leitor desconectado';
  return `Bridge conectado: ${state.readerName || 'leitor NFC'}`;
}

function loadKioskContent() {
  if (!kioskWindow || kioskWindow.isDestroyed()) return;
  const url = getKioskUrl();
  if (!url) {
    kioskWindow.loadFile(SETUP_FILE);
    return;
  }
  const doLoad = () => kioskWindow?.loadURL(url);
  if (!bridgeState.serverStarted) {
    setTimeout(doLoad, 3000);
  } else {
    doLoad();
  }
}

function createKioskWindow() {
  if (kioskWindow && !kioskWindow.isDestroyed()) return;

  kioskWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    resizable: true,
    fullscreen: false,
    kiosk: false,
    autoHideMenuBar: true,
    backgroundColor: '#0B0F1A',
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Ctrl+Shift+Q = saída rápida de administrador
  kioskWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key === 'Q') {
      event.preventDefault();
      kioskWindow?.removeAllListeners('closed');
      app.quit();
    }
  });

  loadKioskContent();

  kioskWindow.webContents.on('did-fail-load', (_, errorCode, _desc, validatedURL) => {
    if (Math.abs(errorCode) === 3) return; // aborted (ex.: navegação intencional)
    if (validatedURL && validatedURL.startsWith('file://')) return; // erro carregando setup.html não deve reciclar
    log.warn('Kiosk failed to load, retrying in 5s', { errorCode });
    clearTimeout(kioskRestartTimer);
    kioskRestartTimer = setTimeout(() => {
      if (kioskWindow && !kioskWindow.isDestroyed()) loadKioskContent();
    }, 5000);
  });
  kioskWindow.on('closed', () => {
    kioskWindow = null;
    log.warn('Kiosk window closed — reopening in 2s');
    clearTimeout(kioskRestartTimer);
    kioskRestartTimer = setTimeout(createKioskWindow, 2000);
  });
  log.info('Kiosk window opened', getKioskUrl() || '(setup screen)');
}

function rebuildMenu() {
  if (!tray) return;
  const state = getBridgeState();
  const winAlive = kioskWindow && !kioskWindow.isDestroyed();
  const menu = Menu.buildFromTemplate([
    { label: statusLabel(), enabled: false },
    { label: `Clientes web: ${state.clients || 0}`, enabled: false },
    { type: 'separator' },
    { label: winAlive ? 'Mostrar Kiosk' : 'Abrir Kiosk', click: () => {
      if (winAlive) kioskWindow.focus();
      else { clearTimeout(kioskRestartTimer); createKioskWindow(); }
    }},
    { label: 'Configurar família', click: () => {
      if (!kioskWindow || kioskWindow.isDestroyed()) { createKioskWindow(); return; }
      kioskWindow.focus();
      kioskWindow.loadFile(SETUP_FILE);
    }},
    { label: 'Abrir status local', click: () => shell.openExternal('http://localhost:8765/status') },
    { label: 'Abrir pasta de logs', click: openLogs },
    { type: 'separator' },
    { label: updateCheckInProgress ? 'Checando atualização...' : 'Checar atualização', enabled: !updateCheckInProgress, click: () => checkForUpdates(true) },
    { label: 'Reiniciar Bridge', click: async () => { await restartBridge(); } },
    { label: 'Reiniciar Kiosk', click: () => {
      kioskWindow?.removeAllListeners('closed');
      kioskWindow?.destroy();
      clearTimeout(kioskRestartTimer);
      setTimeout(createKioskWindow, 500);
    }},
    { type: 'separator' },
    { label: 'Sair', click: () => {
      kioskWindow?.removeAllListeners('closed');
      app.quit();
    }},
  ]);
  tray.setToolTip(`${APP_NAME} - ${statusLabel()}`);
  tray.setContextMenu(menu);
}

async function restartBridge() {
  try {
    if (bridgeHandle) await stopBridge();
    bridgeHandle = await startBridge({
      logger: log,
      onStateChange: (state) => {
        bridgeState = { ...bridgeState, ...(state || {}) };
        rebuildMenu();
      }
    });
    bridgeState = { ...bridgeState, ...getBridgeState() };
    log.info('Bridge restarted');
  } catch (error) {
    log.error('Bridge restart failed', error);
    dialog.showErrorBox('CareID Kiosk', `Falha ao iniciar bridge: ${error.message || error}`);
  } finally {
    rebuildMenu();
  }
}

async function setupAutoLaunch() {
  try {
    const launcher = new AutoLaunch({ name: APP_NAME, path: app.getPath('exe') });
    const enabled = await launcher.isEnabled();
    if (!enabled) await launcher.enable();
    log.info('Auto-launch enabled');
  } catch (error) {
    log.warn('Auto-launch setup failed', error);
  }
}

function setupAutoUpdaterEvents() {
  autoUpdater.on('checking-for-update', () => {
    updateCheckInProgress = true;
    log.info('Checking for updates');
    rebuildMenu();
  });

  autoUpdater.on('update-available', (info) => {
    log.info('Update available', info);
    if (manualUpdateCheck) {
      dialog.showMessageBox({
        type: 'info',
        title: APP_NAME,
        message: 'Atualização encontrada',
        detail: `Baixando versão ${info.version || 'mais recente'} em segundo plano.`
      });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info('No update available', info);
    if (manualUpdateCheck) {
      dialog.showMessageBox({
        type: 'info',
        title: APP_NAME,
        message: 'Nenhuma atualização disponível',
        detail: `Versão atual: ${app.getVersion()}`
      });
    }
  });

  autoUpdater.on('error', (error) => {
    log.warn('Update check failed', error);
    if (manualUpdateCheck) {
      dialog.showErrorBox(
        APP_NAME,
        `Falha ao checar atualização. Verifique a internet e os logs do Kiosk.\n\nDetalhe: ${error.message || error}`
      );
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded', info);
    dialog.showMessageBox({
      type: 'info',
      buttons: ['Instalar agora', 'Instalar ao sair'],
      defaultId: 0,
      cancelId: 1,
      title: APP_NAME,
      message: 'Atualização pronta para instalar',
      detail: `A versão ${info.version || 'mais recente'} foi baixada.`
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall(false, true);
      }
    });
  });
}

async function checkForUpdates(manual = false) {
  if (updateCheckInProgress) return;

  manualUpdateCheck = manual;

  try {
    if (!app.isPackaged) {
      log.info('Skipping update check because app is not packaged.');
      if (manual) {
        dialog.showMessageBox({
          type: 'info',
          title: APP_NAME,
          message: 'Atualização disponível apenas no app instalado',
          detail: 'O auto-update não roda em ambiente de desenvolvimento.'
        });
      }
      return;
    }

    await autoUpdater.checkForUpdates();
  } catch (error) {
    log.warn('Update check failed', error);
    if (manual) {
      dialog.showErrorBox(
        APP_NAME,
        `Falha ao checar atualização. Verifique a internet e os logs do Kiosk.\n\nDetalhe: ${error.message || error}`
      );
    }
  } finally {
    updateCheckInProgress = false;
    setTimeout(() => { manualUpdateCheck = false; }, 1000);
    rebuildMenu();
  }
}

// --- IPC handlers (called from preload/renderer) ---
ipcMain.handle('kiosk:save-config', (event, config) => {
  writeConfig(config);
  log.info('Kiosk config saved', config);
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (sender === kioskWindow) loadKioskContent();
});
ipcMain.handle('kiosk:clear-config', () => {
  clearConfig();
  log.info('Kiosk config cleared');
});
ipcMain.handle('kiosk:get-config', () => readConfig());
ipcMain.handle('kiosk:quit', () => {
  kioskWindow?.removeAllListeners('closed');
  app.quit();
});

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    app.setLoginItemSettings({ openAtLogin: true });
    tray = new Tray(createIcon());
    tray.on('click', () => {
      if (kioskWindow && !kioskWindow.isDestroyed()) kioskWindow.focus();
      else { clearTimeout(kioskRestartTimer); createKioskWindow(); }
    });
    setupAutoUpdaterEvents();
    rebuildMenu();
    await setupAutoLaunch();
    await restartBridge();
    createKioskWindow();
    menuRefreshTimer = setInterval(rebuildMenu, 5000);
    checkForUpdates(false);
  });

  app.on('window-all-closed', (event) => {
    event.preventDefault();
  });

  app.on('before-quit', async () => {
    if (menuRefreshTimer) clearInterval(menuRefreshTimer);
    clearTimeout(kioskRestartTimer);
    try { await stopBridge(); } catch {}
  });
}
