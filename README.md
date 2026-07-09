# Neuvo Care Kiosk Bridge

Bridge local Windows para leitores NFC USB usados no Kiosk do Neuvo Care.

## Configuração identificada no Neuvo Care

- Repo analisado: `gabrielfds/neuvo-care-frontend-b2935491`.
- Rota do kiosk: `/kiosk` em `src/App.tsx`.
- Tela principal: `src/pages/Kiosk.tsx`.
- Hook NFC: `src/hooks/useKioskBridge.ts`.
- WebSocket esperado: `ws://localhost:8765`.
- Fallback: Web NFC quando disponível; bridge USB quando Web NFC não existe.
- Código aceito: `CARE-XXXXX` direto ou URL contendo `/r/CARE-XXXXX`.
- URL recomendada para abrir no Windows: `https://appcare.neuvo.com.br/kiosk`.

## Base reaproveitada do CareID

Este pacote segue a versão nova do CareID Bridge:

- Electron tray app.
- Single-instance lock.
- Auto-launch no Windows.
- Auto-update via GitHub Releases.
- Logs locais.
- Status local em `http://localhost:8765/status`.
- Leitura NFC via `nfc-pcsc`.

## Próximo passo obrigatório

Criar o repo público:

`gabrielfds/neuvo-care-kiosk-bridge-releases`

O token atual de automação não tem permissão para criar repositório nem fazer push.

## Ícone do executável

Ícone recebido de Gabriel em 2026-07-09 e aplicado em:

- `assets/icon.svg` — fonte recebida.
- `assets/icon.png` — raster 256x256 para tray/fallback.
- `assets/icon.ico` — ícone Windows usado pelo instalador/executável.

Configuração em `package.json`:

```json
"win": {
  "icon": "assets/icon.ico"
}
```
