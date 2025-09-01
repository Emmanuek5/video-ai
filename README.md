# video-ai

AI-powered video generation tool that creates engaging videos using the Vercel AI SDK, OpenAI, and the Pexels API. It generates a script, sources high‑quality clips, produces narration via TTS, and compiles everything into a final video with transitions and aspect‑ratio optimization.

## 🚀 Features

- **AI script generation**: Structured, engaging scripts with hooks and key points
- **Smart query generation**: 5–8 AI‑generated search queries prioritized by relevance
- **High‑quality sourcing (Pexels)**: Oriented for 16:9 or 9:16; deduped and quality‑scored
- **Text‑to‑speech (OpenAI)**: Natural narration with `tts-1`
- **AI image generation**: Uses `dall-e-3` for a cover/visual
- **Advanced compilation**: Scaling/cropping, color enhancement, sharpening, and transitions
- **Caching + performance metrics**: Cached script/search results and timing logs

## Prerequisites

- Node.js 18+ or Bun (recommended)
- FFmpeg and FFprobe installed and available in PATH
  - Windows: Download from `https://www.gyan.dev/ffmpeg/builds/` and add the `bin` folder to PATH
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt-get install ffmpeg`

## Setup

### 1) Install dependencies

```bash
bun install
```

### 2) Configure environment

Create `.env` (or copy from `.env.example` if present) and set:

```env
# OpenRouter (for text generation via Vercel AI SDK / OpenRouter)
OPENROUTER_API_KEY=your_openrouter_api_key

# OpenAI (for TTS and image generation)
OPENAI_API_KEY=your_openai_api_key

# Pexels (for stock videos)
PEXELS_API_KEY=your_pexels_api_key
```

Getting API keys:

- OpenRouter: sign up at [OpenRouter](https://openrouter.ai/)
- OpenAI: see [OpenAI API keys](https://platform.openai.com/)
- Pexels: request at [Pexels API](https://www.pexels.com/api/)

### 3) Run

```bash
bun run index.ts
```

## Usage

```typescript
import { VideoAI } from "./lib/ai";

const videoAI = new VideoAI({
  AI_API_KEY: process.env.OPENROUTER_API_KEY!, // OpenRouter
  OPENAI_API_KEY: process.env.OPENAI_API_KEY!, // OpenAI (TTS / images)
  PEXELS_API_KEY: process.env.PEXELS_API_KEY!, // Pexels
  model: "anthropic/claude-3.5-sonnet", // Any OpenRouter model id
  aspectRatio: "9:16", // "16:9" or "9:16"
});

const { videoPath, aspectRatio } = await videoAI.generateVideo(
  "Fun history facts about the world"
);
console.log({ videoPath, aspectRatio });
```

## How it works

1. Script generation (OpenRouter via Vercel AI SDK; structured JSON with hooks/key points)
2. AI query generation (5–8 prioritized search queries)
3. Video sourcing (Pexels API; orientation‑aware, deduped, quality‑scored, concurrent downloads)
4. TTS narration (OpenAI `tts-1`), image generation (`dall-e-3`)
5. Compilation (FFmpeg scaling/cropping, color enhancement, sharpening, transitions, bitrate tuning)

## Aspect ratios

- **16:9 (Landscape)**: 1920×1080 — YouTube, desktop‑first content
- **9:16 (Portrait)**: 1080×1920 — TikTok, Instagram Reels, Shorts

The pipeline selects suitable orientation from Pexels and applies smart scaling/cropping to fit the target output while preserving quality.

## Configuration

`new VideoAI({...})` supports:

- `AI_API_KEY` (string, required): OpenRouter API key
- `OPENAI_API_KEY` (string, required): OpenAI key for TTS and images
- `PEXELS_API_KEY` (string, required): Pexels API key
- `model` (string, optional): OpenRouter model id (default: `gpt-4.1` in code, passed to OpenRouter provider)
- `aspectRatio` ("16:9" | "9:16", optional): Output aspect ratio (default: `16:9`)
- `tmpDir` (string, optional): Directory for intermediate files

## Troubleshooting

- **“ffmpeg/ffprobe not found”**: Ensure FFmpeg and FFprobe are installed and in PATH. On Windows, verify the `ffmpeg\bin` directory is in the System PATH and restart the terminal.
- **API key errors**: Confirm `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, and `PEXELS_API_KEY` are set in `.env` and that your terminal session was restarted after changes.
- **Pexels requests failing**: Check network access and that your API key is valid. The provider retries downloads and logs progress; see console for details.
- **Slow/failed downloads**: The downloader retries with exponential backoff and shows MB/s; unstable networks may still cause failures — try again.

## Notes

- This project prefers the Pexels API over site scraping for reliability and licensing. A legacy scraper exists in `lib/video-scraper.ts` but is not used in the main pipeline.
- Created with `bun init` (Bun v1.1.42). See [Bun](https://bun.sh).

## Changelog

See `CHANGELOG.md` for notable changes.
