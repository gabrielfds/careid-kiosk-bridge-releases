# CareID Kiosk Bridge

Bridge local Windows para leitores NFC USB usados no CareID Kiosk.

## O que faz

- Sobe servidor local em `127.0.0.1:8765`.
- Expõe `http://localhost:8765/status`.
- Envia leituras NFC por WebSocket para o Kiosk web.
- Fica no tray icon.
- Abre `https://kiosk.careidtag.com.br`.
- Inicia com Windows.
- Usa GitHub Releases para auto-update.

## Build local

```bash
npm install
npm run dist
```

## Release grátis via GitHub

1. Atualize `version` no `package.json`.
2. Crie uma tag:

```bash
git tag v0.1.0
git push origin main --tags
```

3. O GitHub Actions gera o instalador e publica os artefatos no Release.

## Observação

A primeira fase é unsigned. Windows pode mostrar aviso de editor desconhecido.
