import { generateObject, generateText, type LanguageModel, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import {
  createOpenRouter,
  type OpenRouterProvider,
} from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { PexelsVideoProvider, type DownloadedVideo } from "./pexels-provider";
import os from "os";
import fs from "fs";
import path from "path";
import { downloadFile } from "./utils";
import { Readable } from "stream";
import { exec } from "child_process";
import { promisify } from "util";
import { VideoEffects } from "./video-effects";
import OpenAI from "openai";
import { performance } from "perf_hooks";
import crypto from "crypto";

const execAsync = promisify(exec);

// Types and schemas
interface Asset {
  path: string;
  type: "video" | "audio" | "image";
}

interface TransitionEffect {
  name: "swipeup" | "swipedown" | "fadein" | "fadeout" | "zoomin" | "zoomout";
  duration: number; // in seconds
}

interface VideoClip {
  path: string;
  duration?: number; // in seconds
}

const VideoSchema = z.object({
  title: z.string(),
  description: z.string(),
  script: z.string(),
  message: z.string(),
  aspectRatio: z.enum(["16:9", "9:16"]),
  assets: z.array(
    z.object({
      path: z.string(),
      type: z.enum(["video", "audio", "image"]),
    })
  ),
  videoPath: z.string(),
});

interface VideoGenerationResult {
  title: string;
  description: string;
  script: string;
  message: string;
  aspectRatio: "16:9" | "9:16";
  assets: Array<{ path: string; type: "video" | "audio" | "image" }>;
  videoPath: string;
}

const configSchema = z.object({
  AI_API_KEY: z.string(),
  OPENAI_API_KEY: z.string(),
  PEXELS_API_KEY: z.string(),
  model: z.string().default("gpt-4.1"),
  aspectRatio: z.enum(["16:9", "9:16"]).default("16:9"),
  tmpDir: z.string().optional(),
});

type Config = z.infer<typeof configSchema>;

const ScriptSchema = z.object({
  title: z.string(),
  description: z.string(),
  script: z.string(),
});

// Add new schema for video queries
const VideoQueriesSchema = z.object({
  queries: z
    .array(
      z.object({
        query: z.string().describe("Search query for video content"),
        relevance: z.string().describe("How this query relates to the script"),
        priority: z
          .number()
          .min(1)
          .max(10)
          .describe("Priority level (1-10, higher is more important)"),
      })
    )
    .min(3)
    .max(8)
    .describe("Array of video search queries with metadata"),
});

export class VideoAI {
  private readonly openaiClient: OpenAI; // Keep for TTS and image generation
  private readonly openrouter: OpenRouterProvider;
  private readonly model: LanguageModel;
  private readonly pexelsProvider: PexelsVideoProvider;
  private readonly tmpDir: string;
  private assets: Asset[] = [];
  private readonly config: Config;
  private readonly cache: Map<string, any> = new Map();
  private readonly performanceMetrics: Map<string, number> = new Map();
  private readonly maxConcurrentDownloads: number = 5;
  private readonly videoEffects: VideoEffects;

  constructor(config: Config) {
    this.config = configSchema.parse(config);
    this.openaiClient = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
    });
    this.openrouter = createOpenRouter({
      apiKey: config.AI_API_KEY,
    });
    this.model = this.openrouter(config.model || "gpt-4o");
    this.tmpDir = config.tmpDir || path.join(__dirname, "../tmp");
    this.pexelsProvider = new PexelsVideoProvider(
      config.PEXELS_API_KEY,
      this.tmpDir
    );
    this.videoEffects = new VideoEffects();
    this.ensureTmpDir();

    // Initialize performance tracking
    console.log("🚀 VideoAI initialized with enhanced performance features");
  }

  private ensureTmpDir(): void {
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }
  }

  private startTimer(operation: string): string {
    const timerId = `${operation}_${Date.now()}`;
    this.performanceMetrics.set(timerId, performance.now());
    return timerId;
  }

  private endTimer(timerId: string, operation: string): number {
    const startTime = this.performanceMetrics.get(timerId);
    if (!startTime) return 0;

    const duration = performance.now() - startTime;
    this.performanceMetrics.delete(timerId);
    console.log(`⏱️  ${operation} completed in ${duration.toFixed(2)}ms`);
    return duration;
  }

  private getCacheKey(operation: string, params: any): string {
    const hash = crypto.createHash("md5");
    hash.update(JSON.stringify({ operation, params }));
    return hash.digest("hex");
  }

  private async withCache<T>(
    key: string,
    operation: () => Promise<T>,
    ttl: number = 300000
  ): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < ttl) {
      console.log(`💾 Cache hit for ${key}`);
      return cached.data;
    }

    const result = await operation();
    this.cache.set(key, { data: result, timestamp: Date.now() });
    console.log(`💾 Cache miss for ${key} - result cached`);
    return result;
  }

  // Add new method to generate video search queries using AI
  private async generateVideoQueries(
    script: string,
    topic: string
  ): Promise<Array<{ query: string; relevance: string; priority: number }>> {
    const timer = this.startTimer("video_queries_generation");

    try {
      console.log("🔍 Generating AI-powered video search queries...");

      const cacheKey = this.getCacheKey("video_queries", {
        script: script.substring(0, 200),
        topic,
      });

      const result = await this.withCache(
        cacheKey,
        async () => {
          const queryResult = await generateObject({
            model: this.model,
            prompt: `Analyze this video script and generate diverse, specific search queries to find relevant video content.

Script: "${script}"
Main Topic: "${topic}"
Aspect Ratio: ${this.config.aspectRatio}

Your task is to create search queries that will help find video clips that match different parts and themes of the script. 

Requirements:
- Generate 5-8 diverse search queries
- Each query should target different aspects/segments of the script
- Prioritize queries that will find visually engaging content
- Consider the ${this.config.aspectRatio} aspect ratio when suggesting content
- Include both specific and broader related terms
- Avoid overly complex or niche terms that might return no results

For each query, provide:
1. The search query (2-4 words, simple and clear)
2. Relevance explanation (how it relates to the script)
3. Priority level (1-10, where 10 is most important)

Focus on queries that will find:
- Action shots and dynamic content
- Nature/landscape footage if relevant
- People/lifestyle content if applicable
- Abstract/artistic visuals for transitions
- Close-up details and textures

Return a JSON object with an array of query objects.`,
            schema: VideoQueriesSchema,
            temperature: 0.6,
          });

          return queryResult.object.queries;
        },
        600000
      ); // 10 minutes cache

      // Sort by priority (highest first)
      const sortedQueries = result.sort((a, b) => b.priority - a.priority);

      console.log(
        `🎯 Generated ${sortedQueries.length} AI-powered video queries:`
      );
      sortedQueries.forEach((q, i) => {
        console.log(
          `  ${i + 1}. "${q.query}" (Priority: ${q.priority}) - ${q.relevance}`
        );
      });

      this.endTimer(timer, "Video queries generation");
      return sortedQueries;
    } catch (error) {
      console.warn(
        "⚠️ AI query generation failed, using fallback queries:",
        error
      );

      // Fallback to topic-based queries
      const fallbackQueries = [
        { query: topic, relevance: "Main topic", priority: 10 },
        {
          query: `${topic} facts`,
          relevance: "Educational content",
          priority: 8,
        },
        { query: `${topic} nature`, relevance: "Natural visuals", priority: 7 },
        { query: `${topic} closeup`, relevance: "Detailed shots", priority: 6 },
        {
          query: "abstract motion",
          relevance: "Transition content",
          priority: 5,
        },
      ];

      console.log("🔄 Using fallback queries based on topic");
      this.endTimer(timer, "Video queries generation (fallback)");
      return fallbackQueries;
    }
  }

  async generateVideo(query: string): Promise<VideoGenerationResult> {
    const mainTimer = this.startTimer("video_generation");

    try {
      console.log("🎬 Starting enhanced video generation pipeline...");

      // Step 1: Generate script with caching
      console.log("📝 Step 1: Generating script...");
      const scriptTimer = this.startTimer("script_generation");
      const title = `Fun Facts About ${query}`;
      const description = `An engaging video exploring ${query} with interesting facts and insights`;
      const cacheKey = this.getCacheKey("script", { title, description });
      const scriptData = await this.withCache(
        cacheKey,
        () => this.generateScript(title, description),
        600000 // 10 minutes cache
      );
      this.endTimer(scriptTimer, "Script generation");

      // Step 2-4: Parallel processing for independent operations
      console.log("🚀 Step 2-4: Parallel processing (Audio, Videos, Image)...");
      const parallelTimer = this.startTimer("parallel_processing");

      const [audioFile, videoFiles, imageFile] = await Promise.all([
        // Audio generation
        this.textToSpeech(scriptData.script),
        // Video search and download with AI-generated queries
        this.scrapeVideosWithAIQueries(query, scriptData.script),
        // Image generation
        this.generateImage(`${scriptData.title} - ${scriptData.description}`),
      ]);

      this.endTimer(parallelTimer, "Parallel processing");

      // Step 5: Compile final video
      console.log("🎞️ Step 5: Compiling final video...");
      const compileTimer = this.startTimer("video_compilation");
      const finalVideoPath = await this.compileVideo(
        videoFiles,
        audioFile,
        imageFile,
        scriptData.script
      );
      this.endTimer(compileTimer, "Video compilation");

      this.endTimer(mainTimer, "Total video generation");
      console.log("✅ Enhanced video generation completed successfully!");

      return {
        title: scriptData.title,
        description: scriptData.description,
        script: scriptData.script,
        message: `Successfully generated video: ${scriptData.title}`,
        aspectRatio: this.config.aspectRatio,
        assets: [...this.assets],
        videoPath: finalVideoPath,
      };
    } catch (error) {
      console.error("❌ Error in video generation:", error);
      throw this.handleError(error);
    }
  }

  private async generateScript(
    title: string,
    description: string
  ): Promise<{ title: string; description: string; script: string }> {
    const aspectRatioInfo =
      this.config.aspectRatio === "9:16"
        ? "mobile-first vertical format - hook viewers in first 3 seconds, fast-paced content"
        : "desktop viewing - can build up more gradually, longer attention spans";

    try {
      // Enhanced script generation with structured output
      const result = await generateObject({
        model: this.model,
        prompt: `You are a professional video script writer. Create an engaging video script.

Topic: "${title}"
Description: "${description}"
Format: ${aspectRatioInfo}

Your task is to create a JSON object with the following structure:
{
  "title": "An engaging, clickable title",
  "description": "SEO-optimized description",
  "script": "The complete video script (60-90 seconds when spoken)",
  "hooks": ["Hook 1", "Hook 2", "Hook 3"],
  "keyPoints": ["Point 1", "Point 2", "Point 3"],
  "callToAction": "Engaging ending"
}

Script Requirements:
- Hook viewers in first 3 seconds
- Include 3-5 fascinating facts
- Conversational tone with natural pauses
- Family-friendly and educational
- Strong call-to-action

Return ONLY the JSON object, no additional text.`,
        schema: z.object({
          title: z
            .string()
            .describe("Catchy, clickable title optimized for the platform"),
          description: z
            .string()
            .describe("SEO-optimized description with keywords"),
          script: z
            .string()
            .describe(
              "Engaging script with natural speech patterns and pauses"
            ),
          hooks: z.array(z.string()).describe("3 alternative opening hooks"),
          keyPoints: z.array(z.string()).describe("Main facts/points covered"),
          callToAction: z
            .string()
            .describe("Compelling ending that encourages engagement"),
        }),
        temperature: 0.7, // Balanced creativity
      });

      console.log("✅ Enhanced script generated with hooks and key points");
      console.log(
        `📊 Generated ${result.object.keyPoints.length} key points and ${result.object.hooks.length} hooks`
      );

      return {
        title: result.object.title,
        description: result.object.description,
        script: result.object.script,
      };
    } catch (error) {
      console.warn(
        "⚠️ Enhanced AI script generation failed, using fallback:",
        error
      );

      // Fallback to basic generateText if structured generation fails
      try {
        console.log("🔄 Trying fallback with generateText...");
        const result = await generateText({
          model: this.model,
          prompt: `Create an engaging video script about "${title}".

Description: ${description}
Format: ${aspectRatioInfo}

Requirements:
- Write a compelling 60-90 second script
- Hook viewers in the first 3 seconds
- Include interesting facts and insights
- Use conversational, energetic tone
- End with a call-to-action
- Make it family-friendly

Write ONLY the script text, no additional formatting.`,
          temperature: 0.7,
        });

        console.log("✅ Fallback script generation successful");
        return { title, description, script: result.text };
      } catch (fallbackError) {
        console.warn(
          "⚠️ Fallback generation also failed, using enhanced static script"
        );

        // Enhanced static script based on the topic
        const script = `Did you know that ${title.toLowerCase()} is full of incredible surprises?

Let me share some mind-blowing facts that will completely change how you see ${description.toLowerCase()}.

First, here's something that will shock you. Throughout history, we've discovered amazing patterns and connections that most people never realize.

But wait, there's more! The deeper we dig, the more fascinating it becomes. These discoveries show us just how remarkable our world truly is.

And here's the most incredible part - there's still so much more to uncover!

What surprised you the most? Drop a comment below and let's discuss these amazing facts together!`;

        console.log("✅ Using enhanced static script");
        return { title, description, script };
      }
    }
  }

  // New method that uses AI-generated queries for video scraping
  private async scrapeVideosWithAIQueries(
    originalQuery: string,
    script: string
  ): Promise<string[]> {
    const timer = this.startTimer("ai_video_scraping");

    try {
      console.log("🤖 Starting AI-powered video scraping...");

      // Step 1: Generate AI-powered search queries
      const videoQueries = await this.generateVideoQueries(
        script,
        originalQuery
      );

      // Step 2: Calculate video distribution based on priorities
      const totalVideosNeeded = 12; // Target number of videos
      const totalPriority = videoQueries.reduce(
        (sum, q) => sum + q.priority,
        0
      );

      // Step 3: Scrape videos from multiple queries in parallel
      const scrapingPromises = videoQueries.map(async (queryData) => {
        const videosForQuery = Math.max(
          1,
          Math.round((queryData.priority / totalPriority) * totalVideosNeeded)
        );

        console.log(
          `🔍 Searching "${queryData.query}": targeting ${videosForQuery} videos (priority: ${queryData.priority})`
        );

        try {
          const videos = await this.scrapeVideos(
            queryData.query,
            videosForQuery
          );
          console.log(
            `✅ Found ${videos.length} videos for "${queryData.query}"`
          );
          return {
            query: queryData.query,
            videos,
            relevance: queryData.relevance,
          };
        } catch (error) {
          console.warn(
            `⚠️ Failed to scrape videos for "${queryData.query}":`,
            error
          );
          return {
            query: queryData.query,
            videos: [],
            relevance: queryData.relevance,
          };
        }
      });

      const results = await Promise.all(scrapingPromises);

      // Step 4: Combine and deduplicate videos
      const allVideos: string[] = [];
      const videoSet = new Set<string>();

      results.forEach((result) => {
        if (result.videos.length > 0) {
          console.log(
            `📹 "${result.query}": ${result.videos.length} videos - ${result.relevance}`
          );
          result.videos.forEach((video) => {
            if (!videoSet.has(video)) {
              videoSet.add(video);
              allVideos.push(video);
            }
          });
        }
      });

      // Step 5: Ensure we have enough videos
      if (allVideos.length < 8) {
        console.log(
          "⚠️ Not enough videos from AI queries, supplementing with original query..."
        );
        const supplementalVideos = await this.scrapeVideos(
          originalQuery,
          8 - allVideos.length
        );
        supplementalVideos.forEach((video) => {
          if (!videoSet.has(video)) {
            allVideos.push(video);
          }
        });
      }

      console.log(`🎯 Total unique videos collected: ${allVideos.length}`);
      this.endTimer(timer, "AI-powered video scraping");

      return allVideos;
    } catch (error) {
      console.error(
        "❌ AI video scraping failed, falling back to original method:",
        error
      );
      return await this.scrapeVideos(originalQuery);
    }
  }

  private async scrapeVideos(
    query: string,
    targetCount: number = 10
  ): Promise<string[]> {
    const timer = this.startTimer("video_scraping");

    try {
      // Determine orientation and quality based on aspect ratio
      const orientation =
        this.config.aspectRatio === "9:16" ? "portrait" : "landscape";
      const cacheKey = this.getCacheKey("videos", {
        query,
        orientation,
        aspectRatio: this.config.aspectRatio,
      });

      const videos = await this.withCache(
        cacheKey,
        async () => {
          console.log(`🔍 Searching for ${orientation} videos: "${query}"`);

          // Try multiple search strategies in parallel for better results
          const searchPromises = [
            // Primary search with exact query
            this.pexelsProvider.searchAndDownloadVideos(query, 6, {
              orientation,
              size: "large",
            }),
            // Secondary search with broader terms
            this.pexelsProvider.searchAndDownloadVideos(
              query.split(" ").slice(0, 2).join(" "), // Use first 2 words
              4,
              { orientation, size: "medium" }
            ),
          ];

          const results = await Promise.allSettled(searchPromises);
          const allVideos: DownloadedVideo[] = [];

          results.forEach((result, index) => {
            if (result.status === "fulfilled") {
              allVideos.push(...result.value);
              console.log(
                `✅ Search strategy ${index + 1} found ${
                  result.value.length
                } videos`
              );
            } else {
              console.warn(
                `⚠️ Search strategy ${index + 1} failed:`,
                result.reason
              );
            }
          });

          // Remove duplicates and select best quality videos
          const uniqueVideos = allVideos.filter(
            (video, index, arr) =>
              arr.findIndex((v) => v.id === video.id) === index
          );

          // Sort by quality metrics (duration, resolution)
          const sortedVideos = uniqueVideos.sort((a, b) => {
            const aScore = a.width * a.height + a.duration * 1000;
            const bScore = b.width * b.height + b.duration * 1000;
            return bScore - aScore;
          });

          return sortedVideos.slice(0, targetCount); // Take top 10 videos
        },
        1800000
      ); // 30 minutes cache for video searches

      if (videos.length === 0) {
        throw new Error(`No ${orientation} videos found for query: ${query}`);
      }

      console.log(
        `🎥 Selected ${videos.length} high-quality ${orientation} videos`
      );

      // Add videos to assets with metadata
      videos.forEach((video) => {
        this.assets.push({
          path: video.localPath,
          type: "video",
        });
      });

      this.endTimer(timer, "Video scraping and processing");
      return videos.map((video) => video.localPath);
    } catch (error) {
      console.error("❌ Error in video scraping:", error);
      throw new Error(`Video scraping failed: ${error}`);
    }
  }

  private async textToSpeech(text: string): Promise<string> {
    console.log(
      "🎙️ Generating speech for text:",
      text.substring(0, 100) + "..."
    );
    const filePath = this.generateTempFilePath("audio.mp3");

    try {
      const mp3 = await this.openaiClient.audio.speech.create({
        model: "tts-1",
        voice: "alloy",
        input: text,
      });

      // Create a readable stream from the array buffer
      const buffer = Buffer.from(await mp3.arrayBuffer());
      console.log(`📏 Audio buffer size: ${buffer.length} bytes`);

      const stream = new Readable();
      stream.push(buffer);
      stream.push(null);

      // Write the stream to file
      const writeStream = fs.createWriteStream(filePath);
      await new Promise((resolve, reject) => {
        stream.pipe(writeStream).on("finish", resolve).on("error", reject);
      });

      // Verify the file was created and has content
      const stats = await fs.promises.stat(filePath);
      console.log(`🎵 Audio file created: ${filePath} (${stats.size} bytes)`);

      if (stats.size === 0) {
        throw new Error("Audio file was created but is empty");
      }

      this.assets.push({ path: filePath, type: "audio" });
      return filePath;
    } catch (error) {
      console.error("❌ Error in textToSpeech:", error);
      throw error;
    }
  }

  private async generateImage(query: string): Promise<string> {
    const filePath = this.generateTempFilePath("image.png");
    const image = await this.openaiClient.images.generate({
      model: "dall-e-3",
      prompt: query,
      size: "1024x1024",
    });

    await downloadFile(image.data![0].url!, filePath);
    this.assets.push({ path: filePath, type: "image" });
    return filePath;
  }

  private async compileVideo(
    videoFiles: string[],
    audioFile: string,
    imageFile: string,
    script: string
  ): Promise<string> {
    const timer = this.startTimer("video_compilation");

    if (videoFiles.length < 2) {
      throw new Error("At least two video clips are required for compilation.");
    }

    const outputPath = this.generateTempFilePath("final_video.mp4");

    try {
      console.log(
        `🎞️ Starting enhanced video compilation with ${videoFiles.length} clips`
      );

      // Step 1: Get audio duration first for timing calculations
      console.log(`🔊 Analyzing audio file: ${audioFile}`);
      const audioStats = await fs.promises.stat(audioFile);
      console.log(
        `🎵 Audio file size: ${(audioStats.size / 1024 / 1024).toFixed(2)} MB`
      );
      const audioDuration = await this.getAudioDuration(audioFile);
      console.log(`⏱️ Audio duration: ${audioDuration.toFixed(2)} seconds`);

      // Step 2: Determine optimal settings based on aspect ratio
      const isPortrait = this.config.aspectRatio === "9:16";
      const targetWidth = isPortrait ? 1080 : 1920;
      const targetHeight = isPortrait ? 1920 : 1080;
      const bitrate = isPortrait ? "2500k" : "4000k"; // Higher bitrate for better quality
      const preset = "medium"; // Balance between speed and quality

      console.log(
        `📱 Target: ${targetWidth}x${targetHeight} @ ${bitrate} (${preset} preset)`
      );

      // Step 3: Create video segments with smart timing
      const segmentDuration = audioDuration / videoFiles.length;
      console.log(
        `📊 Each video segment: ${segmentDuration.toFixed(2)} seconds`
      );

      // Step 4: Process videos in parallel for better performance
      const processedVideos: string[] = [];
      const processingPromises = videoFiles.map(async (videoFile, index) => {
        const segmentPath = this.generateTempFilePath(`segment_${index}.mp4`);

        // Enhanced video processing with quality filters
        const videoFilters = [
          `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase`,
          `crop=${targetWidth}:${targetHeight}`,
          "unsharp=5:5:1.0:5:5:0.0", // Sharpen filter
          "eq=contrast=1.1:brightness=0.05:saturation=1.2", // Color enhancement
        ].join(",");

        const command = `ffmpeg -i "${videoFile}" -t ${segmentDuration} -vf "${videoFilters}" -c:v libx264 -preset ${preset} -crf 18 -c:a aac -b:a 192k "${segmentPath}"`;

        await execAsync(command);
        return segmentPath;
      });

      const processedSegments = await Promise.all(processingPromises);
      console.log(`✅ Processed ${processedSegments.length} video segments`);

      // Step 5: Add smooth transitions between segments
      const transitionEffects = [
        "fadein",
        "fadeout",
        "swipeup",
        "swipedown",
        "zoomin",
        "zoomout",
      ] as const;
      const randomEffect =
        transitionEffects[Math.floor(Math.random() * transitionEffects.length)];

      const transitionedVideoPath = this.generateTempFilePath(
        "transitioned_video.mp4"
      );
      await this.videoEffects.addEffectBetweenClips(
        processedSegments.map((path) => ({ path })),
        { name: randomEffect, duration: 0.5 }, // Shorter, smoother transitions
        transitionedVideoPath
      );

      console.log(`✨ Applied ${randomEffect} transitions between clips`);

      // Step 6: Final compilation with high-quality settings
      console.log(`🔗 Final compilation with enhanced quality...`);

      const finalCommand = [
        "ffmpeg",
        `-i "${transitionedVideoPath}"`,
        `-i "${audioFile}"`,
        "-c:v libx264",
        `-preset ${preset}`,
        "-crf 18", // High quality (lower = better quality)
        `-b:v ${bitrate}`,
        "-c:a aac",
        "-b:a 192k",
        "-map 0:v:0",
        "-map 1:a:0",
        "-shortest",
        "-movflags +faststart", // Optimize for web streaming
        "-pix_fmt yuv420p", // Ensure compatibility
        `-y "${outputPath}"`,
      ].join(" ");

      console.log(`🛠️ Enhanced FFmpeg command: ${finalCommand}`);
      await execAsync(finalCommand);

      // Step 7: Verify output quality
      const outputStats = await fs.promises.stat(outputPath);
      console.log(
        `📊 Final video size: ${(outputStats.size / 1024 / 1024).toFixed(2)} MB`
      );

      // Cleanup processed segments
      await Promise.all([
        ...processedSegments.map((path) =>
          fs.promises.unlink(path).catch(console.error)
        ),
        fs.promises.unlink(transitionedVideoPath).catch(console.error),
      ]);

      this.endTimer(timer, "Enhanced video compilation");
      console.log(`✅ High-quality video created: ${outputPath}`);

      return outputPath;
    } catch (error) {
      console.error("❌ Video compilation failed:", error);
      throw new Error(`Enhanced video compilation failed: ${error}`);
    }
  }

  // ... (rest of the code remains the same)
  async getAudioDuration(audioFile: string): Promise<number> {
    const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioFile}"`;
    const { stdout } = await execAsync(command);
    return parseFloat(stdout.trim());
  }

  private generateTempFilePath(filename: string): string {
    return path.join(this.tmpDir, `${Date.now()}-${filename}`);
  }

  private getSystemPrompt(): string {
    const aspectRatioInfo =
      this.config.aspectRatio === "9:16"
        ? "vertical/portrait format (9:16) suitable for TikTok, Instagram Reels, and YouTube Shorts"
        : "horizontal/landscape format (16:9) suitable for traditional YouTube videos";

    return `You are a specialized assistant for crafting engaging video scripts.
            
            VIDEO FORMAT: This video will be created in ${aspectRatioInfo}.
            
            Process:
            1. Generate an engaging script
            2. Convert script to audio
            3. Generate relevant imagery
            4. Find and process video clips (optimized for ${this.config.aspectRatio} aspect ratio)
            5. Compile final video


           Guidelines:
      - The video is optimized for ${this.config.aspectRatio} aspect ratio
      - You can use the scrapeVideos tool to find and download video clips relevant to the script
      - Each topic should have its own scrapeVideos call not combined with other topics
      - The video should be at least a minute long
      - Use at least 10-15 video clips for each video 
      - If a clip is too long use just a small part of it to achieve the desired length and the 10-15 video clips rule
      - Let the clips line up with the script so as to make the video engaging
      - Consider the ${aspectRatioInfo} when selecting and arranging content


      Ensure all content is family-friendly and engaging.`;
  }

  private handleError(error: unknown): Error {
    if (error instanceof z.ZodError) {
      return new Error(`Validation error: ${error.message}`);
    }
    if (error instanceof Error) {
      return error;
    }
    return new Error("An unknown error occurred");
  }

  // Update the VideoAI class method
  private async addEffectbetweenClips(
    type: "swipeup" | "swipedown" | "fadein" | "fadeout" | "zoomin" | "zoomout",
    duration: number = 1.0
  ): Promise<void> {
    const videoAssets = this.assets.filter((asset) => asset.type === "video");
    if (videoAssets.length < 2) {
      throw new Error("At least 2 video clips are required to add effects");
    }

    const videoEffects = new VideoEffects();
    const outputPath = this.generateTempFilePath("processed_video.mp4");

    try {
      await videoEffects.addEffectBetweenClips(
        videoAssets.map((asset) => ({ path: asset.path })),
        { name: type, duration },
        outputPath
      );

      // Replace the original video assets with the processed video
      this.assets = this.assets.filter((asset) => asset.type !== "video");
      this.assets.push({
        path: outputPath,
        type: "video",
      });
    } catch (error) {
      throw new Error(`Failed to add effects between clips: ${error}`);
    }
  }
  getPerformanceSummary(): {
    cacheHits: number;
    totalOperations: number;
    cacheSize: number;
  } {
    const cacheHits = Array.from(this.cache.values()).length;
    return {
      cacheHits,
      totalOperations: this.performanceMetrics.size,
      cacheSize: this.cache.size,
    };
  }

  clearCache(): void {
    this.cache.clear();
    console.log("💾 Cache cleared");
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.assets.map((asset) =>
        fs.promises.unlink(asset.path).catch(console.error)
      )
    );
    this.assets = [];
  }
}
