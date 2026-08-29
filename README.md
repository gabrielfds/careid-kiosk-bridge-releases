# CareID Kiosk

App Windows nativo do CareID Kiosk, com leitor NFC USB embutido (bridge local).

## O que faz

- Abre uma **janela** própria (não tela cheia) carregando a tela de **login** real do CareID (`/auth`). Quem loga escolhe o caminho: administrador cai em `/admin` (de onde grava tags), família cai em `/portal` (de onde abre o modo Presença daquela família).
- Sobe servidor local em `127.0.0.1:8765` (bridge NFC embutido no mesmo processo).
- Expõe `http://localhost:8765/status`.
- Envia leituras NFC por WebSocket/HTTP para a janela do Kiosk (leitura e gravação de tags).
- Fica no tray icon com atalhos (mostrar kiosk, voltar para o login, reiniciar bridge, reiniciar kiosk, sair).
- Inicia com Windows.
- Usa GitHub Releases para auto-update.
- Mantém apenas uma instância ativa (single-instance lock); uma segunda abertura só foca a janela existente.
- Ignora detecções duplicadas do mesmo UID antes da leitura NDEF para reduzir eventos duplicados do ACR122U.

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


## Notas operacionais

### Múltiplas instâncias

A partir da versão `0.1.4`, o app usa single-instance lock do Electron. Se o Bridge já estiver rodando na tray, abrir o atalho novamente não deve iniciar outro servidor na porta `127.0.0.1:8765`.

### Auto-update

O botão **Checar atualização** mostra feedback visual quando:

- está checando atualização;
- não há nova versão;
- encontrou e está baixando uma nova versão;
- baixou e pode instalar;
- houve erro de rede/acesso ao release.

O auto-update depende dos assets publicados no GitHub Release e do acesso do app instalado a esses assets. Se o repositório/release exigir autenticação, o cliente instalado pode não conseguir atualizar sozinho.
