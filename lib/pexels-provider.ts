import { downloadFile, formatBytes, formatDuration } from "./utils";
import path from 'path';
import fs from 'fs';

export interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  url: string;
  image: string;
  duration: number;
  user: {
    id: number;
    name: string;
    url: string;
  };
  video_files: Array<{
    id: number;
    quality: string;
    file_type: string;
    width: number | null;
    height: number | null;
    link: string;
  }>;
  video_pictures: Array<{
    id: number;
    nr: number;
    picture: string;
  }>;
}

export interface PexelsSearchResponse {
  page: number;
  per_page: number;
  total_results: number;
  url: string;
  videos: PexelsVideo[];
  next_page?: string;
  prev_page?: string;
}

export interface DownloadedVideo {
  id: number;
  title: string;
  localPath: string;
  duration: number;
  width: number;
  height: number;
  thumbnailUrl: string;
}

export class PexelsVideoProvider {
  private apiKey: string;
  private baseUrl: string = 'https://api.pexels.com/videos';
  private tmpDir: string;
  private readonly maxConcurrentDownloads: number = 5;
  private readonly retryAttempts: number = 3;
  private readonly downloadTimeout: number = 30000; // 30 seconds

  constructor(apiKey: string, tmpDir: string = path.join(__dirname, '../tmp')) {
    if (!apiKey) {
      throw new Error('Pexels API key is required');
    }
    this.apiKey = apiKey;
    this.tmpDir = tmpDir;
    this.ensureTmpDir();
  }

  private ensureTmpDir(): void {
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }
  }

  /**
   * Search for videos on Pexels
   */
  async searchVideos(
    query: string,
    options: {
      per_page?: number;
      page?: number;
      orientation?: 'landscape' | 'portrait' | 'square';
      size?: 'large' | 'medium' | 'small';
      locale?: string;
    } = {}
  ): Promise<PexelsSearchResponse> {
    const {
      per_page = 15,
      page = 1,
      orientation,
      size,
      locale = 'en-US'
    } = options;

    const params = new URLSearchParams({
      query,
      per_page: per_page.toString(),
      page: page.toString(),
      locale
    });

    if (orientation) {
      params.append('orientation', orientation);
    }
    if (size) {
      params.append('size', size);
    }

    const url = `${this.baseUrl}/search?${params.toString()}`;

    try {
      const response = await fetch(url, {
        headers: {
          'Authorization': this.apiKey,
          'User-Agent': 'video-ai/1.0.0'
        }
      });

      if (!response.ok) {
        throw new Error(`Pexels API error: ${response.status} ${response.statusText}`);
      }

      return await response.json() as PexelsSearchResponse;
    } catch (error) {
      console.error('Error searching videos on Pexels:', error);
      throw new Error(`Failed to search videos: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get the best quality video file URL from a Pexels video
   */
  private getBestQualityVideoUrl(video: PexelsVideo): string | null {
    // Filter out HLS streams and prioritize by quality and file size
    const videoFiles = video.video_files
      .filter(file => file.file_type === 'video/mp4' && file.quality !== 'hls')
      .sort((a, b) => {
        // Prioritize by quality: hd > sd > preview
        const qualityOrder = { 'hd': 3, 'sd': 2, 'preview': 1 };
        const aQuality = qualityOrder[a.quality as keyof typeof qualityOrder] || 0;
        const bQuality = qualityOrder[b.quality as keyof typeof qualityOrder] || 0;
        
        if (aQuality !== bQuality) {
          return bQuality - aQuality; // Higher quality first
        }
        
        // If same quality, prefer higher resolution
        const aPixels = (a.width || 0) * (a.height || 0);
        const bPixels = (b.width || 0) * (b.height || 0);
        return bPixels - aPixels;
      });

    return videoFiles.length > 0 ? videoFiles[0].link : null;
  }

  /**
   * Download a video from Pexels with enhanced progress tracking
   */
  async downloadVideo(video: PexelsVideo): Promise<DownloadedVideo | null> {
    const videoUrl = this.getBestQualityVideoUrl(video);
    
    if (!videoUrl) {
      console.error(`❌ No suitable video URL found for video ${video.id}`);
      return null;
    }

    try {
      const filename = `pexels_${video.id}_${Date.now()}.mp4`;
      const localPath = path.join(this.tmpDir, filename);
      
      console.log(`📥 Downloading video ${video.id} (${video.width}x${video.height}, ${formatDuration(video.duration)})`);
      
      await downloadFile(videoUrl, localPath, {
        timeout: this.downloadTimeout,
        maxRetries: this.retryAttempts,
        onProgress: (progress) => {
          if (progress.percentage % 25 === 0) { // Log every 25%
            console.log(`📊 Video ${video.id}: ${progress.percentage}% (${formatBytes(progress.downloaded)}/${formatBytes(progress.total)})`);
          }
        }
      });
      
      // Verify file was downloaded successfully
      const stats = await fs.promises.stat(localPath);
      if (stats.size === 0) {
        throw new Error('Downloaded file is empty');
      }
      
      console.log(`✅ Video ${video.id} downloaded successfully (${formatBytes(stats.size)})`);
      
      return {
        id: video.id,
        title: `Video by ${video.user.name}`,
        localPath,
        duration: video.duration,
        width: video.width,
        height: video.height,
        thumbnailUrl: video.image
      };
    } catch (error) {
      console.error(`❌ Failed to download video ${video.id}:`, error);
      return null;
    }
  }

  /**
   * Search and download videos with enhanced concurrent processing
   */
  async searchAndDownloadVideos(
    query: string,
    maxVideos: number = 10,
    options: {
      orientation?: 'landscape' | 'portrait' | 'square';
      size?: 'large' | 'medium' | 'small';
    } = {}
  ): Promise<DownloadedVideo[]> {
    try {
      console.log(`🔍 Enhanced search for "${query}" (max: ${maxVideos}, orientation: ${options.orientation || 'any'})`);
      
      const searchResult = await this.searchVideos(query, {
        per_page: Math.min(maxVideos * 2, 80), // Get more results for better selection
        ...options
      });

      if (!searchResult.videos || searchResult.videos.length === 0) {
        console.log(`⚠️ No videos found for query: ${query}`);
        return [];
      }

      // Filter and sort videos by quality metrics
      const qualityVideos = searchResult.videos
        .filter(video => {
          // Filter out very short or very long videos
          return video.duration >= 3 && video.duration <= 60;
        })
        .sort((a, b) => {
          // Sort by quality score (resolution * duration)
          const aScore = (a.width * a.height) + (a.duration * 100);
          const bScore = (b.width * b.height) + (b.duration * 100);
          return bScore - aScore;
        })
        .slice(0, maxVideos);

      console.log(`🎥 Selected ${qualityVideos.length} high-quality videos from ${searchResult.videos.length} results`);

      // Process downloads with concurrency control
      const successfulDownloads: DownloadedVideo[] = [];
      
      for (let i = 0; i < qualityVideos.length; i += this.maxConcurrentDownloads) {
        const batch = qualityVideos.slice(i, i + this.maxConcurrentDownloads);
        console.log(`📦 Processing batch ${Math.floor(i / this.maxConcurrentDownloads) + 1}/${Math.ceil(qualityVideos.length / this.maxConcurrentDownloads)}`);
        
        const batchPromises = batch.map(video => this.downloadVideoWithRetry(video));
        const batchResults = await Promise.allSettled(batchPromises);
        
        batchResults.forEach((result, batchIndex) => {
          const video = batch[batchIndex];
          if (result.status === 'fulfilled' && result.value) {
            successfulDownloads.push(result.value);
            console.log(`✅ Downloaded: ${result.value.title} (${result.value.width}x${result.value.height})`);
          } else {
            console.error(`❌ Failed to download video ${video.id}:`, 
              result.status === 'rejected' ? result.reason : 'Unknown error');
          }
        });
      }

      console.log(`🎉 Successfully downloaded ${successfulDownloads.length}/${qualityVideos.length} videos`);
      return successfulDownloads;
      
    } catch (error) {
      console.error('❌ Error in enhanced searchAndDownloadVideos:', error);
      throw error;
    }
  }

  /**
   * Download video with retry logic
   */
  private async downloadVideoWithRetry(video: PexelsVideo): Promise<DownloadedVideo | null> {
    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        return await this.downloadVideo(video);
      } catch (error) {
        console.warn(`⚠️ Download attempt ${attempt}/${this.retryAttempts} failed for video ${video.id}:`, error);
        
        if (attempt === this.retryAttempts) {
          console.error(`❌ All ${this.retryAttempts} attempts failed for video ${video.id}`);
          return null;
        }
        
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
    return null;
  }

  /**
   * Get popular videos
   */
  async getPopularVideos(
    options: {
      per_page?: number;
      page?: number;
      min_width?: number;
      min_height?: number;
      min_duration?: number;
      max_duration?: number;
    } = {}
  ): Promise<PexelsSearchResponse> {
    const {
      per_page = 15,
      page = 1,
      min_width,
      min_height,
      min_duration,
      max_duration
    } = options;

    const params = new URLSearchParams({
      per_page: per_page.toString(),
      page: page.toString()
    });

    if (min_width) params.append('min_width', min_width.toString());
    if (min_height) params.append('min_height', min_height.toString());
    if (min_duration) params.append('min_duration', min_duration.toString());
    if (max_duration) params.append('max_duration', max_duration.toString());

    const url = `${this.baseUrl}/popular?${params.toString()}`;

    try {
      const response = await fetch(url, {
        headers: {
          'Authorization': this.apiKey,
          'User-Agent': 'video-ai/1.0.0'
        }
      });

      if (!response.ok) {
        throw new Error(`Pexels API error: ${response.status} ${response.statusText}`);
      }

      return await response.json() as PexelsSearchResponse;
    } catch (error) {
      console.error('Error getting popular videos from Pexels:', error);
      throw new Error(`Failed to get popular videos: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Clean up downloaded videos
   */
  cleanup(videos: DownloadedVideo[]): void {
    videos.forEach(video => {
      if (video.localPath && fs.existsSync(video.localPath)) {
        try {
          fs.unlinkSync(video.localPath);
          console.log(`Cleaned up: ${video.localPath}`);
        } catch (error) {
          console.error(`Failed to delete video: ${video.localPath}`, error);
        }
      }
    });
  }
}
