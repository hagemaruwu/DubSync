# DubSync — YouTube Hindi Dubbing Extension

An end-to-end system consisting of a **Chrome Extension (Manifest V3)** and a **Node.js backend** that automatically extracts English captions from YouTube videos, translates them to Hindi using Azure Translator, synthesizes high-quality speech using Azure Cognitive Services Speech SDK (`hi-IN-MadhurNeural`), stitches audio clips with drift-correction using FFmpeg (`atempo` filter), and syncs dubbed playback seamlessly in real-time.

---

## 🏗️ Architecture & Pipeline

```
[YouTube Video]
       │
       ▼
1. yt-dlp Caption Fetching & Cleaning (deduplication & sentence-level grouping)
       │
       ▼
2. Azure Translator REST API v3 (batched EN → HI translation)
       │
       ▼
3. Azure Speech SDK TTS (Neural synthesis with bounded concurrency)
       │
       ▼
4. FFmpeg Stitcher (slot duration calculation, atempo speedup cap & silence padding)
       │
       ▼
[Synced Hindi Audio Stream via Chrome Extension Content Script]
```

---

## 🛠️ Prerequisites

1. **System Dependencies:**
   - [yt-dlp](https://github.com/yt-dlp/yt-dlp): `brew install yt-dlp`
   - [ffmpeg](https://ffmpeg.org/): `brew install ffmpeg`
   - [Node.js](https://nodejs.org/) v18+

2. **Azure Cognitive Services:**
   - Microsoft Azure Account with Speech Service & Translator Service enabled.

---

## 🚀 Setup Instructions

### 1. Backend Setup

1. Navigate to the `backend/` directory:
   ```bash
   cd backend
   npm install
   ```

2. Configure environment variables:
   ```bash
   cp .env.example .env
   ```
   Fill in your Azure credentials in `.env`:
   ```env
   AZURE_SPEECH_KEY=your_speech_key_here
   AZURE_SPEECH_REGION=centralindia
   AZURE_TRANSLATOR_KEY=your_translator_key_here
   AZURE_TRANSLATOR_REGION=centralindia
   AZURE_TRANSLATOR_ENDPOINT=https://api.cognitive.microsofttranslator.com
   PORT=3001
   ```

3. Start the backend server:
   ```bash
   npm run dev
   ```

### 2. Chrome Extension Setup

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** on (top-right corner).
3. Click **Load unpacked** and select the `extension/` folder in this repository.
4. The **DubSync** icon will now appear in your browser toolbar!

---

## 🎯 Usage

1. Start the backend server (`npm run dev`).
2. Open any English YouTube video with captions available.
3. Click the **DubSync** extension icon and click **Dub this video**.
4. The extension handles syncing, muting the original English audio, and playing the dubbed Hindi audio in real-time.

---

## 🧹 Maintenance

To clean up cached and temporary audio files generated during processing:
```bash
cd backend
npm run clean
```

---

## 📄 License
MIT License
