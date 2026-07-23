import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';

export const FILE_STORAGE_SERVICE = Symbol('FileStorageService');

export interface StoredFile {
  key: string;
  originalName: string;
}

export interface ReadResult {
  stream: Readable;
  originalName: string;
  mimeType: string;
  size: number;
}

export interface FileStorageService {
  store(file: Express.Multer.File, subfolder: string): Promise<StoredFile>;
  read(storageKey: string): Promise<ReadResult>;
}

@Injectable()
export class LocalDiskFileStorageService implements FileStorageService {
  private readonly basePath: string;

  constructor(configService: ConfigService) {
    this.basePath = configService.get<string>('FILE_STORAGE_PATH', './uploads');
  }

  async store(
    file: Express.Multer.File,
    subfolder: string,
  ): Promise<StoredFile> {
    const safeName = path
      .basename(file.originalname)
      .replace(/\s+/g, '_')
      .replace(/[^\w.-]+/g, '');
    const key = `${subfolder}/${randomUUID()}-${safeName}`;
    const filePath = this.resolveKey(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, file.buffer);
    await fs.writeFile(
      `${filePath}.meta.json`,
      JSON.stringify({
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      }),
    );
    return { key, originalName: file.originalname };
  }

  async read(storageKey: string): Promise<ReadResult> {
    const filePath = this.resolveKey(storageKey);
    const stat = await fs.stat(filePath);
    let originalName = this.stripPrefix(path.basename(storageKey));
    let mimeType = 'application/octet-stream';
    try {
      const meta = JSON.parse(
        await fs.readFile(`${filePath}.meta.json`, 'utf8'),
      );
      if (meta.originalName) originalName = meta.originalName;
      if (meta.mimeType) mimeType = meta.mimeType;
    } catch {
      // No sidecar metadata present; fall back to derived defaults.
    }
    return {
      stream: createReadStream(filePath),
      originalName,
      mimeType,
      size: stat.size,
    };
  }

  private resolveKey(storageKey: string): string {
    const base = path.resolve(this.basePath);
    const resolved = path.resolve(base, ...storageKey.split('/'));
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error('Invalid storage key');
    }
    return resolved;
  }

  private stripPrefix(name: string): string {
    return name.replace(/^[a-f0-9-]{36}-/, '');
  }
}
