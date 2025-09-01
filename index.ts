import { VideoAI } from './lib/ai';
import dotenv from 'dotenv';

dotenv.config();

const AI_API_KEY = process.env.OPENROUTER_API_KEY!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY!;

if (!OPENAI_API_KEY) {
    throw new Error('OPENROUTER_API_KEY environment variable is required');
}

if (!PEXELS_API_KEY) {
    throw new Error('PEXELS_API_KEY environment variable is required');
}

if (!AI_API_KEY) {
    throw new Error('AI_API_KEY environment variable is required');
}

async function testVideoGeneration() {
    // You can change this to '9:16' for vertical videos (TikTok/Instagram Reels)
    // or '16:9' for horizontal videos (YouTube)
    const aspectRatio = '9:16'; // Change this as needed
    
    const videoAI = new VideoAI({
        AI_API_KEY: AI_API_KEY as string, // OpenRouter API key for text generation
        OPENAI_API_KEY: OPENAI_API_KEY as string, // OpenAI API key for TTS and image generation
        PEXELS_API_KEY: PEXELS_API_KEY as string,
        model: 'anthropic/claude-3.5-sonnet', // Better for structured output
        aspectRatio: aspectRatio
    });

    try {
        console.log(`Starting video generation test in ${aspectRatio} aspect ratio...`);
        const result = await videoAI.generateVideo('Fun history facts about julius caesar');
      console.log(result);
      
    } catch (error) {
        console.error('Error during video generation:', error);
    } finally {
   
    }
}

// Run the test
testVideoGeneration().catch(console.error);
