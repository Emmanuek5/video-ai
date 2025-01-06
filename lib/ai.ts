import OpenAI from "openai";
import { z } from 'zod';
import IStockVideoScraper from "./video-scraper";
import type { Video } from "./video-scraper";
import os from 'os';
import fs from 'fs';
import path from 'path';
import { zodFunction, zodResponseFormat } from "openai/helpers/zod.mjs";
import type { ChatCompletionTool } from "openai/src/resources/index.js";
import { downloadFile } from "./utils";
import { Readable } from 'stream';
import { exec } from 'child_process';
import { promisify } from 'util';
import { VideoEffects } from "./video-effects";


const execAsync = promisify(exec);

// Types and schemas
interface Asset {
  path: string;
  type: 'video' | 'audio' | 'image';
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
  assets: z.array(z.object({
    path: z.string(),
    type: z.enum(['video', 'audio', 'image'])
  })),
  videoPath: z.string(),
});

interface VideoGenerationResult extends Video {
  videoPath: string;
}

const configSchema = z.object({
    OPENAI_API_KEY: z.string(),
    model: z.string().default('gpt-4-turbo-preview'),
    tmpDir: z.string().optional(),
});

type Config = z.infer<typeof configSchema>;


const ScriptSchema = z.object({
    title: z.string(),
    description: z.string(),
    script: z.string(),
});

export class VideoAI {
    private readonly openai: OpenAI;
    private readonly tmpDir: string;
    private assets: Asset[] = [];
    private readonly config: Config;
    private readonly tools: ChatCompletionTool[];
    

    constructor(config: Config) {
        this.config = configSchema.parse(config);
        this.openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
        this.tmpDir = config.tmpDir || path.join(__dirname, '../tmp');
        this.ensureTmpDir();

        this.tools = this.initializeTools();
    }

    private ensureTmpDir(): void {
        if (!fs.existsSync(this.tmpDir)) {
            fs.mkdirSync(this.tmpDir, { recursive: true });
        }
    }

    private initializeTools(): ChatCompletionTool[] {
        return [
            {
                type: "function",
                function: {
                    name: "scrapeVideos",
                    strict: true,
                    description: "Scrape relevant videos from the internet",
                    parameters: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "Search query for video scraping"
                            }
                        },
                        additionalProperties: false,
                        required: ["query"]
                    }
                }
            },
          {
            type: "function",
            function: {
              name: "generateScript",
              description: "Generate video script",
              strict: true,
              parameters: {
                type: "object",
                properties: {
                  title: {
                    type: "string",
                    description: "Video title"
                  },
                  description: {
                    type: "string",
                    description: "Video description"
                  }
                },
                additionalProperties: false,
                required: ["title", "description"]
              }
            }
          },
            {
                type: "function",
                function: {
                    name: "textToSpeech",
                    strict: true,
                    description: "Convert script text to speech audio",
                    parameters: {
                        type: "object",
                        properties: {
                            text: {
                                type: "string",
                                description: "Text to convert to speech"
                            }
                        },
                        additionalProperties: false,
                        required: ["text"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "generateImage",
                    strict: true,
                    description: "Generate thumbnail or background image",
                    parameters: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "Image description to generate"
                            }
                        },
                        additionalProperties: false,
                        required: ["query"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "compileVideo",
                    strict: true,
                    description: "Compile final video from assets",
                    parameters: {
                        type: "object",
                        properties: {
                            videoFiles: {
                                type: "array",
                                items: { type: "string" },
                                description: "Video file paths"
                            },
                            audioFile: {
                                type: "string",
                                description: "Audio file path"
                            },
                            imageFile: {
                                type: "string",
                                description: "Image file path"
                            },
                            script: {
                                type: "string",
                                description: "Video script"
                            }
                        },
                        additionalProperties: false,
                        required: ["videoFiles", "audioFile", "imageFile", "script"]
                    }
                }
            },
        ];
    }

    async generateVideo(query: string): Promise<VideoGenerationResult> {
        try {
            const messages: Array<OpenAI.Chat.ChatCompletionMessageParam> = [
                {
                    role: "system",
                    content: this.getSystemPrompt()
                },
                {
                    role: "user",
                    content: `Generate a video about ${query}.`
                }
            ];

            return await this.executeVideoGeneration(messages);
        } catch (error) {
            
            throw this.handleError(error);
        } finally {
          await  setTimeout(async() => {
            this.cleanup();
          }, 5000);
        }
    }

    private async executeVideoGeneration(messages: Array<OpenAI.Chat.ChatCompletionMessageParam>): Promise<any> {
        while (true) {

       

            const completion = await this.openai.beta.chat.completions.parse({
                model: this.config.model,
                messages,
                tools: this.tools,
                tool_choice: "auto",
                response_format: zodResponseFormat(VideoSchema, 'video')
            });

            const responseMessage = completion.choices[0].message;
            messages.push(responseMessage);

            if (responseMessage.tool_calls?.length) {
                const toolResults = await Promise.all(
                    responseMessage.tool_calls.map(call => this.handleToolCall(call))
                );

                for (let i = 0; i < toolResults.length; i++) {
                    messages.push({
                        role: "tool",
                        tool_call_id: responseMessage.tool_calls[i].id,
                        content: JSON.stringify(toolResults[i])
                    });
                }
            } else if (responseMessage.content) {
                const result = completion.choices[0].message.parsed;
                // Return final result with video path
                return result;
            }
        }
    }

    private async handleToolCall(toolCall: OpenAI.Chat.ChatCompletionMessageToolCall): Promise<any> {
        const args = JSON.parse(toolCall.function.arguments);
        
        switch (toolCall.function.name) {
            case 'scrapeVideos':
                return await this.scrapeVideos(args.query);
            case 'textToSpeech':
                return await this.textToSpeech(args.text);
            case 'generateImage':
                return await this.generateImage(args.query);
            case 'generateScript':
                return await this.generateScript(args.title, args.description);
            case 'compileVideo':
                return await this.compileVideo(args.videoFiles, args.audioFile, args.imageFile, args.script);
            case 'addEffectBetweenClips':
                return await this.addEffectbetweenClips(args.clips, args.effect);
            default:
                throw new Error(`Unknown function: ${toolCall.function.name}`);
        }
    }


    private async generateScript(title: string, description: string): Promise<any> {
      const ScriptSchema = z.object({
        plainScript: z.string(),
        formattedScript: z.string(),
        actions: z.array(z.string()),
      })

      const scriptResponse = await this.openai.beta.chat.completions.parse({
        model: this.config.model,
        messages: [
          {
            role: 'system',
            content: `
            You are a Video Script Writer for YouTube Shorts. 
            You will be given a title and a description of a video and your task is to generate a script that will be used to create a video about this title and description.

            The script should be in the following format:

            plainScript: The script in plain text without any things like 'Cut to' or 'Jump to' in the beginning.
            formattedScript: The script in a formatted way with 'Cut to' and 'Jump to' in the beginning.
            actions: An array of actions that will be used to create the video eg 'Cut to' or 'Jump to'. 
            `,
          },
          {
            role: 'user',
            content: `Generate a video script for a video about ${title} with the following description: ${description}`,
          },
        ],
        response_format: zodResponseFormat(ScriptSchema, 'script'),
      });

      const script = scriptResponse.choices[0].message.parsed;


      return {
        plainScript: script?.plainScript,
        formattedScript: script?.formattedScript,
        actions: script?.actions,
      };
    
    }
    private async scrapeVideos(query: string): Promise<string[]> {
      const scraper = new IStockVideoScraper();
      const videos = await scraper.scrapeVideos(query);
      const videoPaths = videos
          .filter(video => video.localPath) // Only include videos that were successfully downloaded
          .map(video => video.localPath!);  // Get the local file paths
      
      this.assets.push(...videoPaths.map(path => ({ 
          path,
          type: 'video' as const
      })));
      
      return videoPaths;
  }

  private async textToSpeech(text: string): Promise<string> {
    const filePath = this.generateTempFilePath('audio.mp3');
    const mp3 = await this.openai.audio.speech.create({
        model: "tts-1",
        voice: "alloy",
        input: text
    });

    // Create a readable stream from the array buffer
    const buffer = Buffer.from(await mp3.arrayBuffer());
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    
    // Write the stream to file
    const writeStream = fs.createWriteStream(filePath);
    await new Promise((resolve, reject) => {
        stream.pipe(writeStream)
            .on('finish', resolve)
            .on('error', reject);
    });

    this.assets.push({ path: filePath, type: 'audio' });
    return filePath;
}

    private async generateImage(query: string): Promise<string> {
        const filePath = this.generateTempFilePath('image.png');
        const image = await this.openai.images.generate({
            model: "dall-e-3",
            prompt: query,
            size: "1024x1024"
        });

        await downloadFile(image.data[0].url!, filePath);
        this.assets.push({ path: filePath, type: 'image' });
        return filePath;
    }

    private async compileVideo(
      videoFiles: string[], 
      audioFile: string, 
      imageFile: string, 
      script: string
    ): Promise<string> {
      if (videoFiles.length < 2) {
        throw new Error("At least two video clips are required for compilation.");
      }
    
      const videoEffects = new VideoEffects();
      const outputPath = this.generateTempFilePath("final_video.mp4");
    
      try {
        const effects = [
          { name: "swipeup", duration: 1 },
          { name: "swipedown", duration: 1 },
          { name: "fadein", duration: 1 },
          { name: "fadeout", duration: 1 },
          { name: "zoomin", duration: 1 },
        ];
    
        // Step 1: Add transitions between video clips
        const processedVideoPath = this.generateTempFilePath("processed_video.mp4");
        await videoEffects.addEffectBetweenClips(
          videoFiles.map(filePath => ({ path: filePath })),
          { 
            name: "fadein", 
            duration: effects[Math.floor(Math.random() * effects.length)].duration 
          },
          processedVideoPath
        );
    
        // Step 2: Get the duration of the audio file
        const audioDuration = await this.getAudioDuration(audioFile);
    
        // Step 3: Trim the processed video to match the audio duration
        const trimmedVideoPath = this.generateTempFilePath("trimmed_video.mp4");
        await execAsync(
          `ffmpeg -i ${processedVideoPath} -t ${audioDuration} -c:v copy -c:a aac ${trimmedVideoPath}`
        );
    
        // Step 4: Overlay the audio onto the trimmed video
        const withAudioPath = this.generateTempFilePath("final_video.mp4");
        await execAsync(
          `ffmpeg -i ${trimmedVideoPath} -i ${audioFile} -c:v copy -c:a aac ${withAudioPath}`
        );
    
        // Cleanup temporary files
        await fs.promises.unlink(processedVideoPath).catch(console.error);
        await fs.promises.unlink(trimmedVideoPath).catch(console.error);
    
        return withAudioPath;
      } catch (error) {
        throw new Error(`Failed to compile video: ${error}`);
      }
    }


    async getAudioDuration(audioFile: string): Promise<number> {
        const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioFile}"`;
        const { stdout } = await execAsync(command);
        return parseFloat(stdout.trim());
    }

    private generateTempFilePath(filename: string): string {
        return path.join(this.tmpDir, `${Date.now()}-${filename}`);
    }

    private getSystemPrompt(): string {
        return `You are a specialized assistant for crafting engaging YouTube Shorts video scripts.
            Available tools:
            ${this.tools.map(tool => `- ${tool.function.name}: ${tool.function.description}`).join('\n')}
            
            Process:
            1. Generate an engaging script using the 'generateScript' tool
            2. Convert script to audio
            3. Generate relevant imagery
            4. Find and process video clips
            5. Compile final video


            Guidelines:
            - You can use the scrapeVideos tool to find and download video clips releveant to the script, you can also use it muliple times to get videos on multiple topics from the same script
            - The video clips should be at least 30 seconds long
            
            
            Ensure all content is family-friendly and engaging.`;
    }

    private handleError(error: unknown): Error {
        if (error instanceof z.ZodError) {
            return new Error(`Validation error: ${error.message}`);
        }
        if (error instanceof Error) {
            return error;
        }
        return new Error('An unknown error occurred');
    }

// Update the VideoAI class method
private async addEffectbetweenClips(
  type: "swipeup" | "swipedown" | "fadein" | "fadeout" | "zoomin" | "zoomout",
  duration: number = 1.0
): Promise<void> {
  const videoAssets = this.assets.filter(asset => asset.type === 'video');
  if (videoAssets.length < 2) {
    throw new Error('At least 2 video clips are required to add effects');
  }

  const videoEffects = new VideoEffects();
  const outputPath = this.generateTempFilePath('processed_video.mp4');

  try {
    await videoEffects.addEffectBetweenClips(
      videoAssets.map(asset => ({ path: asset.path })),
      { name: type, duration },
      outputPath
    );

    // Replace the original video assets with the processed video
    this.assets = this.assets.filter(asset => asset.type !== 'video');
    this.assets.push({
      path: outputPath,
      type: 'video'
    });
  } catch (error) {
    throw new Error(`Failed to add effects between clips: ${error}`);
  }
}
    async cleanup(): Promise<void> {
        await Promise.all(
            this.assets.map(asset => 
                fs.promises.unlink(asset.path).catch(console.error)
            )
        );
        this.assets = [];
    }
}


