import axios from 'axios';
import fs from 'fs';
import { performance } from 'perf_hooks';

export interface DownloadProgress {
    downloaded: number;
    total: number;
    percentage: number;
    speed: number; // bytes per second
}

export async function downloadFile(
    url: string, 
    outputPath: string, 
    options: {
        timeout?: number;
        onProgress?: (progress: DownloadProgress) => void;
        maxRetries?: number;
    } = {}
): Promise<string> {
    const { timeout = 30000, onProgress, maxRetries = 3 } = options;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const startTime = performance.now();
            let downloadedBytes = 0;
            
            const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream',
                timeout,
                headers: {
                    'User-Agent': 'video-ai/2.0.0'
                }
            });

            const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
            const writer = fs.createWriteStream(outputPath);
            
            // Track download progress
            response.data.on('data', (chunk: Buffer) => {
                downloadedBytes += chunk.length;
                
                if (onProgress && totalBytes > 0) {
                    const currentTime = performance.now();
                    const elapsedSeconds = (currentTime - startTime) / 1000;
                    const speed = downloadedBytes / elapsedSeconds;
                    
                    onProgress({
                        downloaded: downloadedBytes,
                        total: totalBytes,
                        percentage: Math.round((downloadedBytes / totalBytes) * 100),
                        speed
                    });
                }
            });
            
            response.data.pipe(writer);

            return new Promise<string>((resolve, reject) => {
                writer.on('finish', () => {
                    const duration = (performance.now() - startTime) / 1000;
                    const speed = downloadedBytes / duration;
                    console.log(`✅ Downloaded ${(downloadedBytes / 1024 / 1024).toFixed(2)} MB in ${duration.toFixed(2)}s (${(speed / 1024 / 1024).toFixed(2)} MB/s)`);
                    resolve(outputPath);
                });
                
                writer.on('error', (error) => {
                    fs.unlink(outputPath, () => {}); // Clean up partial file
                    reject(error);
                });
                
                response.data.on('error', (error: Error) => {
                    writer.destroy();
                    fs.unlink(outputPath, () => {}); // Clean up partial file
                    reject(error);
                });
            });
            
        } catch (error) {
            console.warn(`⚠️ Download attempt ${attempt}/${maxRetries} failed:`, error);
            
            if (attempt === maxRetries) {
                throw new Error(`Download failed after ${maxRetries} attempts: ${error}`);
            }
            
            // Wait before retry with exponential backoff
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
    
    throw new Error('Download failed: Maximum retries exceeded');
}

export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatDuration(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}