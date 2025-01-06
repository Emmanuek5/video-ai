import puppeteer, { Page, Browser } from 'puppeteer';
import path from 'path';
import fs from 'fs';
import https from 'https';

export interface Video {
    title: string;
    thumbnailUrl: string;
    previewUrl: string;
    videoSourceUrl: string | null;
    localPath?: string; // Path where the video is saved locally
}

class IStockVideoScraper {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private baseUrl: string = 'https://www.istockphoto.com';
    private tmpDir: string;

    constructor(tmpDir: string = path.join(__dirname, '../tmp')) {
        this.tmpDir = tmpDir;
        this.ensureTmpDir();
    }

    private ensureTmpDir(): void {
        if (!fs.existsSync(this.tmpDir)) {
            fs.mkdirSync(this.tmpDir, { recursive: true });
        }
    }

    private async init(): Promise<void> {
        if (!this.browser) {
            this.browser = await puppeteer.launch({ 
                headless: false,
                args: ['--autoplay-policy=no-user-gesture-required'] // Allow autoplay
            });
        }
        if (!this.page) {
            this.page = await this.browser.newPage();
            // Enable video downloading
            await this.page.setRequestInterception(true);
            this.page.on('request', request => {
                request.continue();
            });
        }
    }

    private async close(): Promise<void> {
        if (this.page) {
            await this.page.close();
            this.page = null;
        }
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }

    private generateSafeFilename(title: string): string {
        // Remove invalid characters and replace spaces with underscores
        return title
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '_')
            .replace(/_+/g, '_')
            .slice(0, 50); // Limit length
    }

    private async downloadVideo(video: Video): Promise<string | null> {
        if (!video.videoSourceUrl) {
            console.error('No video source URL available for:', video.title);
            return null;
        }

        const filename = `${this.generateSafeFilename(video.title)}_${Date.now()}.mp4`;
        const filePath = path.join(this.tmpDir, filename);

        return new Promise((resolve, reject) => {
            https.get(video.videoSourceUrl!, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download video: ${response.statusCode}`));
                    return;
                }

                const fileStream = fs.createWriteStream(filePath);
                response.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    resolve(filePath);
                });

                fileStream.on('error', (error) => {
                    fs.unlink(filePath, () => {}); // Clean up on error
                    reject(error);
                });
            }).on('error', (error) => {
                fs.unlink(filePath, () => {}); // Clean up on error
                reject(error);
            });
        });
    }

    public async scrapeVideos(query: string, maxVideos: number = 5): Promise<Video[]> {
        const videos: Video[] = [];
        await this.init();
    
        try {
            const url = `${this.baseUrl}/search/2/film?family=creative&phrase=${encodeURIComponent(query)}`;
            await this.page?.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    
            await this.page?.waitForFunction(
                () => document.querySelectorAll('[data-testid="gallery-mosaic-asset"]').length > 0,
                { timeout: 60000 }
            );
    
            const videoElements = await this.page?.$$('[data-testid="gallery-mosaic-asset"]');
    
            if (!videoElements || videoElements.length === 0) {
                console.log(`No videos found for query: ${query}`);
                return [];  // Return an empty array if no results are found
            }
    
            for (let i = 0; i < Math.min(maxVideos, videoElements.length); i++) {
                const elementHandle = videoElements[i];
                await elementHandle.hover();
    
                // Wait longer for video playback
                await this.page?.waitForSelector(
                    `[data-testid="gallery-mosaic-asset"]:nth-child(${i + 1}) video`,
                    { timeout: 10000 }
                );
    
                // Add a small delay to ensure video loads
                await new Promise(resolve => setTimeout(resolve, 1000));
    
                const videoData = await this.page?.evaluate((index) => {
                    const element = document.querySelectorAll('[data-testid="gallery-mosaic-asset"]')[index];
                    const titleElement = element.querySelector('figcaption');
                    const imgElement = element.querySelector('img');
                    const previewLink = element.querySelector('a');
                    const videoElement = element.querySelector('video');
    
                    return {
                        title: titleElement?.textContent?.trim() || `video_${index}`,
                        thumbnailUrl: imgElement?.getAttribute('src') || '',
                        previewUrl: previewLink?.getAttribute('href') || '',
                        videoSourceUrl: videoElement?.src || videoElement?.currentSrc || null,
                    };
                }, i);
    
                if (videoData) {
                    try {
                        // Download the video and get its local path
                        const localPath = await this.downloadVideo(videoData);
                        if (localPath) {
                            videos.push({
                                ...videoData,
                                localPath
                            });
                            console.log(`Successfully downloaded: ${videoData.title}`);
                        }
                    } catch (error) {
                        console.error(`Failed to download video: ${videoData.title}`, error);
                    }
                }
            }
        } catch (error) {
            console.error('Error during scraping:', error);
        } finally {
            await this.close();
        }
    
        return videos;
    }
    
    // Clean up downloaded videos
    public cleanupVideos(videos: Video[]): void {
        videos.forEach(video => {
            if (video.localPath && fs.existsSync(video.localPath)) {
                try {
                    fs.unlinkSync(video.localPath);
                } catch (error) {
                    console.error(`Failed to delete video: ${video.localPath}`, error);
                }
            }
        });
    }
}

export default IStockVideoScraper;