# 🎤 Karaokê

![Java](https://img.shields.io/badge/Java-21-orange)
![Spring Boot](https://img.shields.io/badge/Spring%20Boot-3.3.5-green)
![Python](https://img.shields.io/badge/Python-3.12-blue)
![ROCm](https://img.shields.io/badge/ROCm-7.x-red)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

Sistema de karaokê caseiro que **baixa músicas do YouTube**, **separa as vozes automaticamente** com IA, **sincroniza letras palavra a palavra** e **roda em qualquer aparelho da rede** via QR code.

---

## 📑 Índice

- [Funcionalidades](#-funcionalidades)
- [Arquitetura](#️-arquitetura)
- [Requisitos](#-requisitos)
- [Instalação](#-instalação)
- [Uso](#-uso)
- [API Reference](#-api-reference)
- [Configuração avançada](#️-configuração-avançada)
- [Troubleshooting](#-troubleshooting)
- [Estrutura de dados](#-estrutura-de-dados)
- [Estrutura do código](#-estrutura-do-código)
- [Contribuindo](#-contribuindo)
- [Licença](#-licença)
- [Aviso legal](#️-aviso-legal)
- [Créditos](#-créditos)

---

## ✨ Funcionalidades

### 🎵 Aquisição de músicas
- Upload de arquivos locais (MP3, FLAC, WAV, M4A, OGG, OPUS…)
- Download direto do YouTube: cole uma URL ou pesquise por nome
- Escolha entre 5 resultados de busca com título, canal e duração
- Edição manual de título/artista antes de baixar
- Detecção automática de metadados (sugere "Título" e "Artista" a partir do vídeo)

### 🎚️ Separação de vozes (IA)
- Separação em duas passadas usando **BS-Roformer** (voz × instrumental) e **Mel-Band Roformer** (voz principal × backing vocals)
- Processamento em GPU com **ROCm** (AMD) ou CUDA (NVIDIA)
- Cada passada roda em subprocesso isolado → **VRAM sempre liberada**, sem degradação entre músicas

### 📝 Letras sincronizadas
- Busca e download automático do **LRCLIB**
- **Detecção automática de offset**: calcula a diferença entre o início real da voz e a primeira linha da letra
- **Alinhamento palavra a palavra** com Whisper (modelos `small`, `medium`, `large-v3`)
- Editor manual de sincronia palavra a palavra com captura por toque/tecla
- Ajuste fino por linha, por palavra, ou global (Atrasar/Adiantar)
- Contagem regressiva de 3s antes da voz entrar

### 🎨 Interface
- Design responsivo (desktop, tablet, celular)
- 4 temas de cor: **Roxo**, **Oceano**, **Âmbar**, **Verde**
- Modo convidado via QR code: outros aparelhos podem ver o catálogo e **adicionar músicas**, mas só o host pode apagar/editar
- Player Web Audio com 3 faders (voz, backing, instrumental)
- Tela cheia de karaokê com letra destacada palavra a palavra

---

## 🏗️ Arquitetura

```
┌─────────────────────────────────────────────────────┐
│                    Rede local                        │
│                                                      │
│  ┌──────────┐    ┌──────────────────┐    ┌────────┐ │
│  │  Host PC │    │   Celular        │    │ Tablet │ │
│  │ (admin)  │    │   (convidado)    │    │(convid)│ │
│  └────┬─────┘    └────────┬─────────┘    └───┬────┘ │
│       │  HTTP :8080       │                  │      │
│       └──────────┬────────┴──────────────────┘      │
│                  ▼                                   │
│  ┌──────────────────────────────────────────────┐   │
│  │  Spring Boot (backend)                       │   │
│  │  ─────────────────────────────────────────   │   │
│  │  • Serve SPA + mídia                         │   │
│  │  • Gerencia biblioteca (meta.json por música)│   │
│  │  • Cliente LRCLIB, iTunes, yt-dlp            │   │
│  │  • Filtro de convidado (IP)                  │   │
│  └──────────────┬───────────────────────────────┘   │
│                 │  HTTP :8001                        │
│                 ▼                                    │
│  ┌──────────────────────────────────────────────┐   │
│  │  FastAPI (separator-service)                 │   │
│  │  ─────────────────────────────────────────   │   │
│  │  • /separate  → audio-separator (Roformer)   │   │
│  │  • /align     → Whisper (stable-ts)          │   │
│  │  • /detect-offset → RMS onset detection      │   │
│  │  • Cada job roda em subprocesso isolado      │   │
│  └──────────────┬───────────────────────────────┘   │
│                 │                                    │
│                 ▼                                    │
│  ┌──────────────────────────────────────────────┐   │
│  │  GPU (ROCm / CUDA)                           │   │
│  │  Roformer + Whisper                          │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

**Stack:**
- **Backend**: Java 21 + Spring Boot 3.3.5
- **Serviço de IA**: Python 3.12 + FastAPI + PyTorch
- **Frontend**: HTML/CSS/JS puro (zero build, sem framework)
- **Ferramentas externas**: `yt-dlp`, `ffmpeg`, `Deno` (opcional)

---

## 📋 Requisitos

### Hardware
- **GPU AMD** (RDNA2+) com ROCm **ou** **GPU NVIDIA** com CUDA
- Recomendado: 6 GB+ de VRAM para rodar `medium` do Whisper + Roformer
- CPU: qualquer coisa moderna (não é o gargalo)

### Software
- **Windows 10/11** (Linux/macOS deve funcionar com ajustes)
- **Java 21** (JDK)
- **Maven 3.9+**
- **Python 3.12**
- **ffmpeg** no `PATH` ([download](https://www.gyan.dev/ffmpeg/builds/))
- **yt-dlp** no `PATH` (`pip install -U yt-dlp`)
- **Deno** (opcional, recomendado — [instalação](https://deno.land/install))
- **PyTorch com ROCm** (AMD) ou **CUDA** (NVIDIA) — ver seção de instalação
- **Git**

---

## 🚀 Instalação

### 1. Clone o repositório

```bash
git clone https://github.com/SEU_USUARIO/karaoke-flow.git
cd karaoke-flow
```

### 2. Instale as ferramentas externas

**Windows (PowerShell como Admin):**

```powershell
# Chocolatey (se não tiver)
Set-ExecutionPolicy Bypass -Scope Process -Force
iex ((New-Object System.Net.WebClient).DownloadString('https://chocolatey.org/install.ps1'))

# Ferramentas
choco install -y ffmpeg python git temurin21 maven

# yt-dlp via pip
pip install -U yt-dlp

# Deno (opcional mas recomendado)
irm https://deno.land/install.ps1 | iex
```

Confirme:
```powershell
ffmpeg -version
yt-dlp --version
java -version
mvn -version
```

### 3. Configure o ambiente Python (separator-service)

```bash
cd separator-service
python -m venv .venv-rocm
.venv-rocm\Scripts\activate
pip install --upgrade pip
```

**Instale o PyTorch conforme sua GPU:**

**AMD (ROCm 7.x no Windows):**
O caminho mais confiável no Windows é usar um fork preparado para `gfx103X` (RDNA2). Recomendamos o [ssubedir/RCOm-windows-gfx1030](https://github.com/ssubedir/RCOm-windows-gfx1030) — ele traz wheels pré-compilados para RX 6600/6700/6800/6900.

```bash
# Siga as instruções do fork para instalar o PyTorch.
pip install torch torchvision torchaudio --index-url https://repo.amd.com/rocm/whl/gfx103X-all/
```

Valide:
```bash
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
# Esperado: True AMD Radeon RX 6600 (ou similar)
```

**NVIDIA (CUDA 12.x):**
```bash
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
```

**Instale as demais dependências:**

```bash
pip install audio-separator stable-ts fastapi "uvicorn[standard]" pydantic openai-whisper
```

### 4. Baixe os modelos de IA

Os modelos são baixados automaticamente na primeira execução. Se preferir pré-baixar:

```bash
# Modelo de separação voz × instrumental
audio-separator --download_model model_bs_roformer_ep_317_sdr_12.9755.ckpt

# Modelo de separação voz principal × backing
audio-separator --download_model mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt
```

### 5. Exporte os cookies do YouTube

O YouTube exige autenticação para downloads desde 2024. **Sem cookies, o yt-dlp falha com "Sign in to confirm you're not a bot".**

1. Instale a extensão [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) no Chrome/Edge.
2. Faça login no YouTube.
3. Vá em `https://www.youtube.com`, clique na extensão → **Export** → **Netscape format**.
4. Salve como `separator-service/cookies.txt`.
5. ⚠️ **Nunca commite este arquivo** — ele contém credenciais da sua conta Google.

> **Renovação**: cookies do Google expiram em ~3 meses. Quando o yt-dlp reclamar de "Sign in" novamente, é só exportar de novo.

### 6. Configure o backend

Edite `backend/src/main/resources/application.yml`:

```yaml
server:
  address: 0.0.0.0
  port: 8080

karaoke:
  storage-dir: ./data/songs
  separator:
    url: http://localhost:8001
    read-timeout: 30m
  ytdlp:
    path: yt-dlp
    cookies: C:/Users/SEU_USUARIO/caminho/para/cookies.txt
```

Ajuste `cookies` para o caminho onde você salvou o arquivo no passo 5 (use barras `/` mesmo no Windows).

### 7. Configure o firewall (uma vez)

Em PowerShell **como Administrador**:

```powershell
New-NetFirewallRule -DisplayName "Karaoke (8080)" `
  -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow -Profile Private
```

Isso permite que celulares na mesma rede Wi-Fi acessem o karaokê.


## 🎮 Uso

### Iniciar o sistema

```bash
start.bat
```

Ou manualmente, em dois terminais:

```bash
# Terminal 1 — serviço Python
cd separator-service
.venv-rocm\Scripts\activate
uvicorn main:app --host 0.0.0.0 --port 8001

# Terminal 2 — backend Java
cd backend
mvn spring-boot:run
```

### Adicionar música

**Via upload local:**
1. **+ Adicionar música** → arraste arquivos ou clique na área
2. Confirme título/artista (preenchidos automaticamente se o nome seguir `Artista - Título.mp3`)
3. **Separar vozes** — a fila processa uma música por vez

**Via YouTube:**
1. **+ Adicionar música** → **Baixar do YouTube**
2. Cole uma URL **ou** digite o nome
3. Escolha entre os 5 resultados
4. Confirme título/artista → **Baixar e separar**

O tempo de separação depende da GPU:
- **RX 6600**: ~4 min na passada 1 + ~2 min na passada 2 (música de 3 min)
- **RTX 3060**: ~2 min + ~1 min
- Processamento ocorre em background; você pode fechar o diálogo

### Adicionar letra

1. No card da música, clique em **⋯** → **Escolher letra**
2. Busque por título/artista (fonte: LRCLIB)
3. Escolha uma versão **sincronizada** (badge verde)
4. O sistema **detecta automaticamente** o offset entre a letra e sua versão do áudio

### Sincronizar palavras (opcional)

Para efeito de "letra destacada palavra a palavra":

1. **⋯** → **Palavras sincronizadas**
2. Escolha o idioma → **Sincronizar palavras** (roda em GPU, ~2–5 min por música)
3. **Ou**: use o **editor manual** para corrigir linhas específicas

### Ajustar sincronia manualmente

Na tela de karaokê, painel **Ajustes** → **Sincronia da letra**:
- **Adiantar 0,5 s** — letra aparece depois do cantor
- **Atrasar 0,5 s** — letra aparece antes do cantor
- **Zerar** — remove o ajuste

O ajuste é salvo por música.

### Cantar

1. Clique em **▶ Cantar** no card da música
2. Escolha o preset: **Karaokê** (voz 0%) ou **Original** (voz 100%)
3. Ajuste os faders se quiser (backing em 60% costuma soar melhor que 100%)
4. **Abrir tela de karaokê** — entra em modo tela cheia

**Atalhos:**
- `Espaço` — play/pause
- `→` / `←` — pular 5 s
- `Esc` — sair da tela cheia
- `/` — focar busca

### Convidados via QR code

1. No host, clique em **Compartilhar** (topo da página)
2. O celular escaneia o QR code → abre a interface em `http://192.168.x.x:8080`
3. **Convidados podem:** ver catálogo, tocar músicas, adicionar novas
4. **Convidados NÃO podem:** apagar, trocar letra/capa, editar palavras

### Trocar tema

Clique no **🎨** no topo. Os temas ciclam em: **Roxo → Oceano → Âmbar → Verde**. A escolha persiste em `localStorage`.

---

## 📡 API Reference

### Backend Spring Boot (porta 8080)

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/songs` | Lista todas as músicas |
| `GET` | `/api/songs/{id}` | Detalhes de uma música |
| `POST` | `/api/songs` | Upload multipart (form-data: `file`, `title`, `artist`) |
| `DELETE` | `/api/songs/{id}` | Apaga música (só host) |
| `POST` | `/api/songs/from-url` | Download direto (JSON: `{"url": "..."}`) |
| `POST` | `/api/songs/youtube/search` | Busca 5 resultados (JSON: `{"query": "..."}`) |
| `POST` | `/api/songs/from-youtube` | Baixa vídeo específico (JSON: `{"videoUrl", "title", "artist"}`) |
| `PUT` | `/api/songs/{id}/lyrics` | Anexa letra do LRCLIB (JSON: `{"lrclibId": 123}`) |
| `PUT` | `/api/songs/{id}/cover` | Anexa capa do iTunes (JSON: `{"url": "..."}`) |
| `POST` | `/api/songs/{id}/words` | Enfileira alinhamento (`?language=pt`) |
| `PUT` | `/api/songs/{id}/words` | Salva palavras manuais |
| `PUT` | `/api/songs/{id}/lyrics-offset` | Ajusta offset (JSON: `{"offsetMs": 1500}`) |
| `GET` | `/api/lyrics/search` | Busca LRCLIB (`?title=&artist=`) |
| `GET` | `/api/covers/search` | Busca iTunes (`?term=`) |
| `GET` | `/api/server-info` | URL da LAN + flag `local` |
| `GET` | `/media/{id}/{file}` | Arquivos de áudio/imagem da música |

### Separator Service (porta 8001)

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/separate` | Separa stems (JSON: `{"input_path", "output_dir"}`) |
| `POST` | `/align` | Alinha palavras (JSON: `{"audio_path", "lrc_path", "output_path", "language", "offset_ms"}`) |
| `POST` | `/detect-offset` | Detecta offset automático (JSON: `{"audio_path", "lrc_path"}`) |

---

## ⚙️ Configuração avançada

### Variáveis de ambiente do backend

`backend/src/main/resources/application.yml`:

```yaml
karaoke:
  storage-dir: ./data/songs            # onde as músicas ficam
  separator:
    url: http://localhost:8001          # URL do serviço Python
    read-timeout: 30m                   # timeout HTTP (separação pode demorar)
  ytdlp:
    path: yt-dlp                        # caminho do executável
    cookies: C:/caminho/cookies.txt     # cookies do YouTube
```

### Variáveis de ambiente do separator-service

| Variável | Padrão | Descrição |
|---|---|---|
| `STEM_MODEL` | `model_bs_roformer_ep_317_sdr_12.9755.ckpt` | Modelo de voz × instrumental |
| `KARAOKE_MODEL` | `mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt` | Modelo de lead × backing |
| `ALIGN_MODEL` | `medium` | Whisper para alinhamento (`base`/`small`/`medium`/`large-v3`) |
| `OUTPUT_FORMAT` | `FLAC` | Formato de saída dos stems |
| `SCRATCH_DIR` | `./scratch` | Pasta temporária |

Para ver todos os modelos disponíveis:
```bash
audio-separator --list_models
```

### Variáveis de ambiente do ROCm (Windows)

Coloque no `.bat` **antes** do uvicorn:

```bat
set MIOPEN_FIND_MODE=2
set PYTORCH_HIP_ALLOC_CONF=expandable_segments:True
```

**Não use** `HSA_OVERRIDE_GFX_VERSION` se seu PyTorch já suporta sua GPU. Essa variável foi necessária em versões antigas do ROCm, mas em builds recentes causa fallback para CPU.

### Performance do Whisper

Trocar `medium` por `small`:
- ✅ 3–5× mais rápido
- ⚠️ Mais erros em trechos difíceis (notas sustentadas, backing vocals)

Recomendação: **`small`** para uso casual, **`medium`** se você quer a melhor qualidade possível e não se importa com 2–3 min de espera por música.

---

## 🔧 Troubleshooting

### GPU

**"No hardware acceleration could be configured, running in CPU mode"**
- Verifique se o PyTorch detecta a GPU:
  ```bash
  python -c "import torch; print(torch.cuda.is_available())"
  ```
- Se `False`, o PyTorch está sem suporte à sua GPU. Instale o wheel correto ([gfx103X para AMD](https://repo.amd.com/rocm/whl/gfx103X-all/)).
- **Remova** `HSA_OVERRIDE_GFX_VERSION` do `.bat` se estiver definida.

**"HSA_OVERRIDE_GFX_VERSION 10.3.0 is invalid"**
- Remova essa variável. O PyTorch moderno já inclui suporte nativo à sua GPU.

**Separação fica lenta depois de algumas músicas (17 s/it em vez de 3 s/it)**
- Confirme que está rodando a versão com subprocessos (`worker.py`) — cada passada roda em processo isolado e libera toda a VRAM.
- Ative `MIOPEN_FIND_MODE=2`.

### yt-dlp

**"Sign in to confirm you're not a bot"**
- Configure os cookies (passo 5 da instalação).
- Renove os cookies se expiraram (~3 meses).

**"Requested format is not available"**
- Instale o **Deno**.
- Confirme que o comando do yt-dlp inclui `--remote-components ejs:github`.

**"HTTP Error 429: Too Many Requests"**
- YouTube está limitando. Aguarde alguns minutos.
- Com cookies configurados, o limite é bem mais generoso.

### Áudio

**Sem áudio no player**
- Verifique se as 3 faixas existem na pasta da música: `instrumental.flac`, `lead.flac`, `backing.flac`.
- Abra o DevTools (F12) → aba Network → filtre por `/media/`. Se algum der 404, o backend não está encontrando o arquivo.

**Eco/realimentação ao cantar com microfone**

Este é um problema **acústico**, não de software. Soluções em ordem de eficácia:
1. Abaixe o ganho do canal do microfone (se estiver >60%, quase certamente é isso)
2. Abaixe o Echo/Delay do mic para ~10%
3. Use microfone dinâmico cardioide (Shure SM58, Behringer XM8500) — **não condensador**
4. Aponte o mic para a boca, mantenha a mão longe da grade
5. Posicione as caixas **à frente** do cantor, apontando para o público (nunca atrás)
6. Adicione cortina/tapete na sala (superfícies macias absorvem reflexão)

### Rede

**Celular não conecta pelo QR code**
- Confirme que celular e PC estão na mesma rede Wi-Fi
- Verifique o firewall: a porta 8080 precisa estar liberada
- Se o QR mostra um IP `169.254.x.x` ou `10.x.x.x` estranho, há uma interface virtual sendo usada. Edite `ServerInfoController.findLanIp()` para filtrar pelo nome da interface (`Wi-Fi` ou `Ethernet`).

### Build

**"variable ytdlp might not have been initialized"**
- Remova o construtor duplicado em `SongService.java`. Deve existir apenas o construtor de 3 argumentos.

---

## 📁 Estrutura de dados

Cada música fica em `backend/data/songs/{uuid}/`:

```
{uuid}/
├── meta.json              # estado da música (título, artista, arquivos, offset, etc.)
├── original.mp3           # áudio original (upload ou YouTube)
├── instrumental.flac      # música sem nenhuma voz
├── lead.flac              # voz principal isolada
├── backing.flac           # backing vocals / coro
├── lyrics.lrc             # letra sincronizada por linha (LRCLIB)
├── words.json             # palavras alinhadas (Whisper ou manual)
└── cover.jpg              # capa (iTunes)
```

---

## 🎨 Estrutura do código

```
karaoke-flow/
├── backend/                            # Spring Boot
│   ├── src/main/java/dev/karaoke/
│   │   ├── KaraokeApplication.java
│   │   ├── config/
│   │   │   ├── KaraokeProperties.java
│   │   │   └── WebConfig.java
│   │   ├── model/
│   │   │   ├── Song.java
│   │   │   ├── SongStatus.java
│   │   │   └── WordsFile.java
│   │   ├── service/
│   │   │   ├── YtDlpClient.java
│   │   │   ├── SeparatorClient.java
│   │   │   ├── LrclibClient.java
│   │   │   ├── ItunesClient.java
│   │   │   └── SongService.java
│   │   └── web/
│   │       ├── SongController.java
│   │       ├── SearchController.java
│   │       ├── ServerInfoController.java
│   │       └── GuestRestrictionFilter.java
│   └── src/main/resources/
│       ├── application.yml
│       └── static/
│           ├── index.html
│           ├── app.js
│           ├── styles.css
│           ├── quotes.js
│           ├── qrcode.js
│           └── favicon.ico
│
└── separator-service/                  # FastAPI + PyTorch
    ├── main.py                          # rotas FastAPI
    ├── worker.py                        # subprocesso de separação
    ├── align_worker.py                  # subprocesso de alinhamento
    ├── aligner.py                       # lógica de alinhamento Whisper
    ├── cookies.txt                      # (gitignored) cookies do YouTube
    └── .venv-rocm/                      # (gitignored) ambiente Python
```

---

## 🤝 Contribuindo

Contribuições são bem-vindas! Antes de abrir um PR:

1. Rode o sistema localmente e teste as mudanças.
2. Se mudar o comportamento de uma API, atualize o README.
3. Mantenha o código comentado em português (padrão do projeto).

**Ideias para contribuir:**
- Suporte a mais modelos de separação (Demucs, MDX-Net)
- Detecção de **BPM** e **tom** para sugerir mudanças de afinação
- Fila de karaokê com "próximo cantor" (nome + música)
- Integração com **Spotify** para puxar metadados
- Suporte a **Linux/macOS**
- Testes automatizados

---

## 📜 Licença

MIT. Use livremente, inclusive comercialmente. Veja [`LICENSE`](./LICENSE).

---

## ⚠️ Aviso legal

O download de conteúdo do YouTube pode violar os [Termos de Serviço](https://www.youtube.com/t/terms) da plataforma. Use este software apenas para:

- Conteúdo de domínio público
- Faixas que você já possui (formato físico ou digital)
- Uso pessoal, em ambiente doméstico

Você é o único responsável pelo uso que faz da ferramenta.

---

## 🙏 Créditos

- [audio-separator](https://github.com/nomadkaraoke/python-audio-separator) — separação de stems
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — download do YouTube
- [stable-ts](https://github.com/jianfch/stable-ts) — alinhamento de palavras
- [LRCLIB](https://lrclib.net/) — base de letras sincronizadas
- [iTunes Search API](https://performance-partners.apple.com/search-api) — capas de álbum
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) — geração de QR codes
- Modelos Roformer: `aufr33`, `viperx`, `Sucial` (comunidade UVR)

---

**Feito com ❤️ para noites de karaokê em casa.**
