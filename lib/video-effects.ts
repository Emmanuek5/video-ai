import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
const execAsync = promisify(exec);

interface VideoClip {
  path: string;
  duration?: number;
}

interface TransitionEffect {
  name: "fadein" | "fadeout" | "swipeup" | "swipedown" | "zoomin" | "zoomout";
  duration: number; // in seconds
}

export class VideoEffects {
  private async getDuration(videoPath: string): Promise<number> {
    const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
    const { stdout } = await execAsync(command);
    return parseFloat(stdout.trim());
  }

  private generateTransitionFilter(effect: TransitionEffect, duration: number): string {
    // Use only fade effects to avoid complex filter issues
    // All other effects will use fade as a fallback for stability
    switch (effect.name) {
      case "fadein":
        return `fade=t=in:st=0:d=${duration}`;
      case "fadeout":
        return `fade=t=out:st=0:d=${duration}`;
      case "swipeup":
        // Use fade instead of complex swipe
        return `fade=t=in:st=0:d=${duration}`;
      case "swipedown":
        // Use fade instead of complex swipe
        return `fade=t=in:st=0:d=${duration}`;
      case "zoomin":
        // Use fade instead of complex zoom
        return `fade=t=in:st=0:d=${duration}`;
      case "zoomout":
        // Use fade instead of complex zoom
        return `fade=t=in:st=0:d=${duration}`;
      default:
        // Default to simple fade
        return `fade=t=in:st=0:d=${duration}`;
    }
  }

  private async applyEffect(
    inputPath: string,
    outputPath: string,
    effect: TransitionEffect,
    clipDuration: number
  ): Promise<string> {
    const filter = this.generateTransitionFilter(effect, clipDuration);
    const command = `ffmpeg -i "${inputPath}" -vf "${filter}" -c:a aac -b:a 192k "${outputPath}"`;
    try {
      await execAsync(command);
      return outputPath;
    } catch (error) {
      throw new Error(`Failed to apply effect ${effect.name}: ${error}`);
    }
  }

  async addEffectBetweenClips(
    clips: VideoClip[],
    effect: TransitionEffect,
    outputPath: string
  ): Promise<string> {
    if (clips.length < 2) {
      throw new Error('At least 2 clips are required to add transitions');
    }

    // Get durations for all clips if not provided
    const clipsWithDuration = await Promise.all(
      clips.map(async (clip) => ({
        ...clip,
        duration: clip.duration || await this.getDuration(clip.path)
      }))
    );

    // Create temporary directory for processed clips
    const tempDir = path.dirname(outputPath);
    const processedClips: string[] = [];

    // Process each clip with the transition effect
    for (let i = 0; i < clipsWithDuration.length; i++) {
      const clip = clipsWithDuration[i];
      const tempOutput = path.join(tempDir, `temp_${i}_${path.basename(outputPath)}`);

      // Apply effect if it's not the last clip
      if (i < clipsWithDuration.length - 1) {
        await this.applyEffect(clip.path, tempOutput, effect, clip.duration!);
      } else {
        // For the last clip, just copy it
        await execAsync(`ffmpeg -i "${clip.path}" -c copy "${tempOutput}"`);
      }

      processedClips.push(tempOutput);
    }

    // Concatenate all processed clips
    const concatList = processedClips.map(clip => `file '${clip}'`).join('\n');
    const concatFile = path.join(tempDir, 'concat_list.txt');
    await fs.promises.writeFile(concatFile, concatList);

    // Concatenate all clips into final output
    await execAsync(
      `ffmpeg -f concat -safe 0 -i "${concatFile}" -c copy "${outputPath}"`
    );

    // Cleanup temporary files
    await Promise.all([
      ...processedClips.map(clip => fs.promises.unlink(clip)),
      fs.promises.unlink(concatFile)
    ]);

    return outputPath;
  }
}