const { app, Menu, Tray, shell, dialog, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const log = require('electron-log');
const AutoLaunch = require('auto-launch');
const { autoUpdater } = require('electron-updater');
const { startBridge, getBridgeState, stopBridge } = require('./bridge');

const KIOSK_URL = process.env.CAREID_KIOSK_URL || 'https://kiosk.careidtag.com.br';
let tray = null;
let bridgeHandle = null;

log.transports.file.level = 'info';
log.transports.console.level = 'info';
autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

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

function rebuildMenu() {
  if (!tray) return;
  const state = getBridgeState();
  const menu = Menu.buildFromTemplate([
    { label: statusLabel(), enabled: false },
    { label: `Clientes web: ${state.clients || 0}`, enabled: false },
    { type: 'separator' },
    { label: 'Abrir Kiosk CareID', click: () => shell.openExternal(KIOSK_URL) },
    { label: 'Abrir status local', click: () => shell.openExternal('http://localhost:8765/status') },
    { label: 'Abrir pasta de logs', click: openLogs },
    { type: 'separator' },
    { label: 'Checar atualização', click: () => autoUpdater.checkForUpdates().catch((err) => log.warn('Update check failed', err)) },
    { label: 'Reiniciar Bridge', click: async () => { await restartBridge(); } },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]);
  tray.setToolTip(`CareID Kiosk Bridge - ${statusLabel()}`);
  tray.setContextMenu(menu);
}

async function restartBridge() {
  try {
    if (bridgeHandle) await stopBridge();
    bridgeHandle = await startBridge({ logger: log, onStateChange: rebuildMenu });
    log.info('Bridge restarted');
  } catch (error) {
    log.error('Bridge restart failed', error);
    dialog.showErrorBox('CareID Kiosk Bridge', `Falha ao iniciar bridge: ${error.message || error}`);
  } finally {
    rebuildMenu();
  }
}

async function setupAutoLaunch() {
  try {
    const launcher = new AutoLaunch({ name: 'CareID Kiosk Bridge', path: app.getPath('exe') });
    const enabled = await launcher.isEnabled();
    if (!enabled) await launcher.enable();
    log.info('Auto-launch enabled');
  } catch (error) {
    log.warn('Auto-launch setup failed', error);
  }
}

app.whenReady().then(async () => {
  app.setLoginItemSettings({ openAtLogin: true });
  tray = new Tray(createIcon());
  rebuildMenu();
  await setupAutoLaunch();
  await restartBridge();
  shell.openExternal(KIOSK_URL).catch((err) => log.warn('Could not open kiosk', err));
  setInterval(rebuildMenu, 5000);
  autoUpdater.checkForUpdatesAndNotify().catch((err) => log.warn('Initial update check failed', err));
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('before-quit', async () => {
  try { await stopBridge(); } catch {}
});
