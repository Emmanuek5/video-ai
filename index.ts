import { VideoAI } from './lib/ai';
import dotenv from 'dotenv';

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable is required');
}

async function testVideoGeneration() {
    const videoAI = new VideoAI({
        OPENAI_API_KEY: OPENAI_API_KEY as string,
        model: 'gpt-4o-mini-2024-07-18'
    });

    try {
        console.log('Starting video generation test...');
        const result = await videoAI.generateVideo('Fun history facts about the world');
      console.log(result);
      
    } catch (error) {
        console.error('Error during video generation:', error);
    } finally {
   
    }
}

// Run the test
testVideoGeneration().catch(console.error);
