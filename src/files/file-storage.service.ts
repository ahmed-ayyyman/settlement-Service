import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';

export interface StoredFile {
  key: string;
  originalName: string;
}

@Injectable()
export class FileStorageService {
  private readonly basePath: string;

  constructor(configService: ConfigService) {
    this.basePath = configService.get<string>('FILE_STORAGE_PATH', './uploads');
  }

  async store(
    file: Express.Multer.File,
    subfolder: string,
  ): Promise<StoredFile> {
    const dir = path.join(this.basePath, subfolder);
    await fs.mkdir(dir, { recursive: true });
    const key = `${randomUUID()}-${file.originalname}`;
    const filePath = path.join(dir, key);
    await fs.writeFile(filePath, file.buffer);
    return { key: path.join(subfolder, key), originalName: file.originalname };
  }

  async read(
    storageKey: string,
  ): Promise<{ buffer: Buffer; originalName: string }> {
    const filePath = path.join(this.basePath, storageKey);
    const buffer = await fs.readFile(filePath);
    const originalName = path
      .basename(storageKey)
      .replace(/^[a-f0-9-]{36}-/, '');
    return { buffer, originalName };
  }
}
