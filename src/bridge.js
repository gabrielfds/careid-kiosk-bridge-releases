const http = require('node:http');
const { NFC } = require('nfc-pcsc');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.CAREID_BRIDGE_PORT || 8765);
const DUPLICATE_WINDOW_MS = Number(process.env.CAREID_DUPLICATE_WINDOW_MS || 2000);

let readerConnected = false;
let readerName = null;
let lastReadKey = null;
let lastReadAt = 0;
let lastDetectionKey = null;
let lastDetectionAt = 0;
let pendingWrite = null;
let lastWriteResult = null;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({
      ok: true,
      readerConnected,
      readerName,
      clients: wss.clients.size,
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/write') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(raw || '{}');
        if (typeof data.url !== 'string' || !/^https?:\/\//i.test(data.url)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'URL inválida para gravação NFC.' }));
          return;
        }

        pendingWrite = {
          url: data.url,
          requestId: data.requestId,
          socket: null,
          requestedAt: Date.now(),
        };
        lastWriteResult = null;
        console.log(`[careid-bridge] HTTP write armed for URL: ${data.url}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          type: 'nfc_write_ready',
          requestId: data.requestId,
          readerConnected,
          reader: readerName,
        }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'JSON inválido.' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/write-result')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(lastWriteResult || { ok: true, pending: Boolean(pendingWrite) }));
    return;
  }

  res.writeHead(404, {
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
});

const wss = new WebSocketServer({ server });

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

function toHex(buffer) {
  return Buffer.from(buffer).toString('hex').toUpperCase();
}

function decodeText(bytes) {
  try {
    return Buffer.from(bytes).toString('utf8').replace(/\0/g, '').trim();
  } catch {
    return '';
  }
}

function parseNdefPayload(ndef) {
  if (!ndef || ndef.length < 3) return null;

  let offset = 0;
  while (offset < ndef.length) {
    const header = ndef[offset++];
    const shortRecord = Boolean(header & 0x10);
    const typeNameFormat = header & 0x07;
    const typeLength = ndef[offset++];
    let payloadLength;

    if (shortRecord) {
      payloadLength = ndef[offset++];
    } else {
      payloadLength = ndef.readUInt32BE(offset);
      offset += 4;
    }

    const idLength = header & 0x08 ? ndef[offset++] : 0;
    const type = ndef.subarray(offset, offset + typeLength).toString('utf8');
    offset += typeLength + idLength;
    const payload = ndef.subarray(offset, offset + payloadLength);
    offset += payloadLength;

    if (typeNameFormat !== 0x01) continue;

    if (type === 'U' && payload.length > 0) {
      const prefixes = [
        '', 'http://www.', 'https://www.', 'http://', 'https://', 'tel:', 'mailto:',
        'ftp://anonymous:anonymous@', 'ftp://ftp.', 'ftps://', 'sftp://', 'smb://',
        'nfs://', 'ftp://', 'dav://', 'news:', 'telnet://', 'imap:', 'rtsp://',
        'urn:', 'pop:', 'sip:', 'sips:', 'tftp:', 'btspp://', 'btl2cap://',
        'btgoep://', 'tcpobex://', 'irdaobex://', 'file://', 'urn:epc:id:',
        'urn:epc:tag:', 'urn:epc:pat:', 'urn:epc:raw:', 'urn:epc:',
        'urn:nfc:',
      ];
      return `${prefixes[payload[0]] || ''}${decodeText(payload.subarray(1))}`;
    }

    if (type === 'T' && payload.length > 0) {
      const languageLength = payload[0] & 0x3f;
      return decodeText(payload.subarray(1 + languageLength));
    }
  }

  return null;
}

function parseType2Ndef(buffer) {
  const bytes = Buffer.from(buffer);
  let offset = 0;

  while (offset < bytes.length) {
    const tag = bytes[offset++];
    if (tag === 0x00) continue;
    if (tag === 0xfe) break;

    let length = bytes[offset++];
    if (length === 0xff) {
      length = bytes.readUInt16BE(offset);
      offset += 2;
    }

    const value = bytes.subarray(offset, offset + length);
    offset += length;

    if (tag === 0x03) return parseNdefPayload(value);
  }

  return null;
}

function encodeUriPayload(url) {
  const prefixes = [
    ['https://www.', 0x02],
    ['http://www.', 0x01],
    ['https://', 0x04],
    ['http://', 0x03],
  ];
  const match = prefixes.find(([prefix]) => url.startsWith(prefix));
  if (!match) return Buffer.concat([Buffer.from([0x00]), Buffer.from(url, 'utf8')]);
  const [prefix, code] = match;
  return Buffer.concat([Buffer.from([code]), Buffer.from(url.slice(prefix.length), 'utf8')]);
}

function createNdefUriTlv(url) {
  const uriPayload = encodeUriPayload(url);
  const ndefRecord = Buffer.concat([
    Buffer.from([0xd1, 0x01, uriPayload.length, 0x55]),
    uriPayload,
  ]);

  if (ndefRecord.length > 254) {
    throw new Error('URL muito longa para gravação NDEF simples nesta versão do bridge.');
  }

  const tlv = Buffer.concat([Buffer.from([0x03, ndefRecord.length]), ndefRecord, Buffer.from([0xfe])]);
  const padding = (4 - (tlv.length % 4)) % 4;
  return padding ? Buffer.concat([tlv, Buffer.alloc(padding)]) : tlv;
}

async function writeTagUrl(reader, url) {
  const data = createNdefUriTlv(url);

  try {
    await readPage(reader, 4);
  } catch (error) {
    throw new Error(`Falha no teste inicial de leitura NTAG/Type 2. Detalhe: ${error.message}`);
  }

  await ensureNdefCapabilityContainer(reader);

  for (let offset = 0; offset < data.length; offset += 4) {
    const page = 4 + offset / 4;
    try {
      await writePage(reader, page, data.subarray(offset, offset + 4));
    } catch (error) {
      const status = error?.message?.match(/Status code:\s*(0x[0-9a-f]+)/i)?.[1] || error?.code || 'desconhecido';
      throw new Error(`A tag recusou a gravação na página ${page} (${status}). Provável MIFARE Classic, tag protegida ou tag incompatível. Use tags NTAG213, NTAG215 ou NTAG216.`);
    }
  }

  const writtenPayload = await readTagPayload(reader, {});
  if (writtenPayload !== url) {
    const dump = await dumpPages(reader, 3, 24);
    console.warn('[careid-bridge] Tag memory dump after failed verification:', dump);
    throw new Error(`Gravação não confirmada. A leitura de volta retornou "${writtenPayload || 'vazio'}" em vez da URL esperada. Dump: ${dump}`);
  }
}

async function ensureNdefCapabilityContainer(reader) {
  const page3 = await readPage(reader, 3);
  if (page3[0] === 0xe1) return;

  // NTAG213 NDEF Capability Container:
  // E1 10 12 00 = NFC Forum Type 2, version 1.0, 144 bytes data area, read/write.
  console.log('[careid-bridge] Formatting NTAG Capability Container for NDEF');
  await writePage(reader, 3, Buffer.from([0xe1, 0x10, 0x12, 0x00]));
}

async function transmit(reader, command, responseMaxLength = 40) {
  return reader.transmit(Buffer.from(command), responseMaxLength);
}

async function getUid(reader) {
  try {
    const response = await transmit(reader, [0xff, 0xca, 0x00, 0x00, 0x00], 40);
    return response.toString('hex').toUpperCase();
  } catch {
    return null;
  }
}

async function readPage(reader, page) {
  // ACR122U PC/SC pseudo APDU: READ BINARY. For NTAG/Ultralight, page = 4 bytes.
  const errors = [];
  try {
    return await readPageDirect(reader, page);
  } catch (error) {
    errors.push(`PN532 InDataExchange READ falhou: ${error.message}`);
  }

  try {
    return await readPageDirectWithLe(reader, page);
  } catch (error) {
    errors.push(`PN532 InDataExchange READ+Le falhou: ${error.message}`);
  }

  try {
    return stripStatusWords(await transmit(reader, [0xff, 0xb0, 0x00, page, 0x04], 40)).subarray(0, 4);
  } catch (error) {
    errors.push(`FF B0 falhou: ${error.message}`);
  }

  throw new Error(errors.join(' | '));
}

async function writePage(reader, page, data) {
  const bytes = Buffer.alloc(4);
  Buffer.from(data).copy(bytes, 0, 0, Math.min(4, data.length));
  // ACR122U PC/SC pseudo APDU: UPDATE BINARY.
  const errors = [];
  try {
    return await writePageDirect(reader, page, bytes);
  } catch (error) {
    errors.push(`PN532 InDataExchange WRITE falhou: ${error.message}`);
  }

  try {
    return await writePageDirectWithLe(reader, page, bytes);
  } catch (error) {
    errors.push(`PN532 InDataExchange WRITE+Le falhou: ${error.message}`);
  }

  try {
    return stripStatusWords(await transmit(reader, [0xff, 0xd6, 0x00, page, 0x04, ...bytes], 40));
  } catch (error) {
    errors.push(`FF D6 falhou: ${error.message}`);
  }

  throw new Error(errors.join(' | '));
}

async function dumpPages(reader, from = 3, to = 20) {
  const lines = [];
  for (let page = from; page <= to; page += 1) {
    try {
      const data = await readPage(reader, page);
      lines.push(`${String(page).padStart(2, '0')}: ${data.toString('hex').toUpperCase()}`);
    } catch (error) {
      lines.push(`${String(page).padStart(2, '0')}: ERROR ${error.message}`);
      break;
    }
  }
  return lines.join(' | ');
}

function stripStatusWords(response) {
  if (response.length >= 2) {
    const sw1 = response[response.length - 2];
    const sw2 = response[response.length - 1];
    if (sw1 === 0x90 && sw2 === 0x00) return response.subarray(0, -2);
  }
  return response;
}

function parsePn532DataExchange(response) {
  const body = stripStatusWords(Buffer.from(response));
  const idx = body.findIndex((byte, index) => byte === 0xd5 && body[index + 1] === 0x41);
  if (idx === -1) throw new Error(`Resposta PN532 inesperada: ${body.toString('hex').toUpperCase()}`);
  const status = body[idx + 2];
  if (status !== 0x00) throw new Error(`PN532 recusou comando NFC. Status: 0x${status.toString(16).padStart(2, '0')}`);
  return body.subarray(idx + 3);
}

async function readPageDirect(reader, page) {
  // ACR122U direct command to PN532 InDataExchange: READ command 0x30.
  const response = await transmit(reader, [0xff, 0x00, 0x00, 0x00, 0x05, 0xd4, 0x40, 0x01, 0x30, page], 64);
  return parsePn532DataExchange(response).subarray(0, 4);
}

async function readPageDirectWithLe(reader, page) {
  const response = await transmit(reader, [0xff, 0x00, 0x00, 0x00, 0x05, 0xd4, 0x40, 0x01, 0x30, page, 0x00], 64);
  return parsePn532DataExchange(response).subarray(0, 4);
}

async function writePageDirect(reader, page, bytes) {
  // ACR122U direct command to PN532 InDataExchange: WRITE command 0xA2.
  const response = await transmit(reader, [0xff, 0x00, 0x00, 0x00, 0x09, 0xd4, 0x40, 0x01, 0xa2, page, ...bytes], 64);
  return parsePn532DataExchange(response);
}

async function writePageDirectWithLe(reader, page, bytes) {
  const response = await transmit(reader, [0xff, 0x00, 0x00, 0x00, 0x09, 0xd4, 0x40, 0x01, 0xa2, page, ...bytes, 0x00], 64);
  return parsePn532DataExchange(response);
}

async function readTagPayload(reader, card) {
  // Most CareID tags are expected to be Type 2/NTAG. Start at page 4,
  // where the NDEF TLV usually begins after the capability container.
  try {
    const chunks = [];
    for (let page = 4; page < 40; page += 1) {
      chunks.push(await readPage(reader, page));
    }
    const data = Buffer.concat(chunks);
    const parsed = parseType2Ndef(data);
    if (parsed) return parsed;
  } catch (error) {
    console.warn('[careid-bridge] Could not read NDEF payload, falling back to UID:', error.message);
  }

  return card.uid || toHex(card.atr || Buffer.alloc(0));
}

function shouldDebounce(uid, payload) {
  const key = `${uid || ''}:${payload || ''}`;
  const now = Date.now();
  if (key === lastReadKey && now - lastReadAt < DUPLICATE_WINDOW_MS) return true;
  lastReadKey = key;
  lastReadAt = now;
  return false;
}

function shouldDebounceDetection(uid, atrHex) {
  const key = uid || atrHex || '';
  const now = Date.now();
  if (key && key === lastDetectionKey && now - lastDetectionAt < DUPLICATE_WINDOW_MS) return true;
  lastDetectionKey = key;
  lastDetectionAt = now;
  return false;
}

wss.on('connection', (socket) => {
  console.log('[careid-bridge] WebSocket client connected');
  socket.send(JSON.stringify({
    type: 'bridge_status',
    readerConnected,
    reader: readerName,
    timestamp: new Date().toISOString(),
  }));
  socket.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data?.type !== 'nfc_write_url') return;
      if (typeof data.url !== 'string' || !/^https?:\/\//i.test(data.url)) {
        socket.send(JSON.stringify({
          type: 'nfc_write_result',
          success: false,
          error: 'URL inválida para gravação NFC.',
          requestId: data?.requestId,
          timestamp: new Date().toISOString(),
        }));
        return;
      }

      pendingWrite = {
        url: data.url,
        requestId: data.requestId,
        socket,
        requestedAt: Date.now(),
      };
      console.log(`[careid-bridge] Waiting for tag to write URL: ${data.url}`);
      socket.send(JSON.stringify({
        type: 'nfc_write_ready',
        requestId: data.requestId,
        readerConnected,
        reader: readerName,
        timestamp: new Date().toISOString(),
      }));
    } catch (error) {
      console.warn('[careid-bridge] Invalid WebSocket command:', error.message);
    }
  });
  socket.on('close', () => {
    if (pendingWrite?.socket === socket) pendingWrite = null;
    console.log('[careid-bridge] WebSocket client disconnected');
  });
});

const nfc = new NFC();

nfc.on('reader', (reader) => {
  // We don't use Android HCE/AID flows here. CareID needs raw NTAG access
  // for ACR122U reads/writes, so automatic ISO 14443-4 processing must stay off.
  reader.autoProcessing = false;

  readerConnected = true;
  readerName = reader.reader.name;
  console.log(`[careid-bridge] Reader connected: ${readerName}`);

  reader.on('card', async (card) => {
    try {
      console.log('[careid-bridge] Card detected:', card);

      const atrHex = toHex(card.atr || Buffer.alloc(0));
      const looksLikePhantomDetection = card.standard === 'TAG_ISO_14443_4' && atrHex === '3B00' && !card.uid;
      if (looksLikePhantomDetection) {
        console.warn('[careid-bridge] Ignoring unstable ACR122U phantom detection (ATR 3B00). Remove the tag and approach it again slowly.');
        const writeSocket = pendingWrite?.socket;
        if (writeSocket && writeSocket.readyState === writeSocket.OPEN) {
          writeSocket.send(JSON.stringify({
            type: 'nfc_write_ready',
            requestId: pendingWrite.requestId,
            readerConnected,
            reader: readerName,
            message: 'Detecção instável do leitor. Afaste a tag e aproxime novamente devagar.',
            timestamp: new Date().toISOString(),
          }));
        }
        return;
      }

      const uid = card.uid || await getUid(reader) || atrHex;

      if (!pendingWrite && shouldDebounceDetection(uid, atrHex)) {
        console.log(`[careid-bridge] Duplicate detection ignored before NDEF read: ${uid}`);
        return;
      }

      if (pendingWrite) {
        const writeJob = pendingWrite;
        pendingWrite = null;
        try {
          await writeTagUrl(reader, writeJob.url);
          const result = {
            type: 'nfc_write_result',
            success: true,
            payload: writeJob.url,
            reader: readerName,
            uid,
            requestId: writeJob.requestId,
            timestamp: new Date().toISOString(),
          };
          console.log('[careid-bridge] Tag written:', result);
          lastWriteResult = { ok: true, ...result };
          if (writeJob.socket?.readyState === writeJob.socket.OPEN) writeJob.socket.send(JSON.stringify(result));
        } catch (error) {
          const result = {
            type: 'nfc_write_result',
            success: false,
            error: error.message || 'Erro ao gravar tag NFC.',
            reader: readerName,
            uid,
            requestId: writeJob.requestId,
            timestamp: new Date().toISOString(),
          };
          console.error('[careid-bridge] Tag write error:', error);
          lastWriteResult = { ok: false, ...result };
          if (writeJob.socket?.readyState === writeJob.socket.OPEN) writeJob.socket.send(JSON.stringify(result));
        }
        return;
      }

      const payload = await readTagPayload(reader, card);

      if (shouldDebounce(uid, payload)) {
        console.log(`[careid-bridge] Duplicate read ignored: ${uid}`);
        return;
      }

      const message = {
        type: 'nfc_read',
        payload,
        reader: readerName,
        uid,
        timestamp: new Date().toISOString(),
      };

      console.log('[careid-bridge] Tag read:', message);
      broadcast(message);
    } catch (error) {
      console.error('[careid-bridge] Tag read error:', error);
    }
  });

  reader.on('error', (error) => {
    console.error(`[careid-bridge] Reader error (${readerName}):`, error);
  });

  reader.on('end', () => {
    console.log(`[careid-bridge] Reader removed: ${readerName}`);
    readerConnected = false;
    readerName = null;
  });
});

nfc.on('error', (error) => {
  console.error('[careid-bridge] NFC subsystem error:', error);
});



function getBridgeState() {
  return {
    serverStarted: server.listening,
    readerConnected,
    readerName,
    clients: wss.clients.size,
    port: PORT,
    lastWriteResult,
  };
}

function startBridge(options = {}) {
  const logger = options.logger || console;
  const onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : () => {};

  const patchStateChange = () => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = (...args) => { logger.info ? logger.info(...args) : originalLog(...args); onStateChange(getBridgeState()); };
    console.warn = (...args) => { logger.warn ? logger.warn(...args) : originalWarn(...args); onStateChange(getBridgeState()); };
    console.error = (...args) => { logger.error ? logger.error(...args) : originalError(...args); onStateChange(getBridgeState()); };
  };
  patchStateChange();

  return new Promise((resolve, reject) => {
    if (server.listening) {
      resolve({ server, wss, nfc });
      return;
    }

    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      console.log(`[careid-bridge] Service started at http://localhost:${PORT}`);
      console.log(`[careid-bridge] WebSocket listening at ws://localhost:${PORT}`);
      onStateChange(getBridgeState());
      resolve({ server, wss, nfc });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, '127.0.0.1');
  });
}

function stopBridge() {
  return new Promise((resolve) => {
    try {
      for (const client of wss.clients) {
        try { client.close(); } catch {}
      }
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

module.exports = { startBridge, stopBridge, getBridgeState };
