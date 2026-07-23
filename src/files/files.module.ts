import { Module } from '@nestjs/common';
import {
  FILE_STORAGE_SERVICE,
  LocalDiskFileStorageService,
} from './file-storage.service';

@Module({
  providers: [
    {
      provide: FILE_STORAGE_SERVICE,
      useClass: LocalDiskFileStorageService,
    },
  ],
  exports: [FILE_STORAGE_SERVICE],
})
export class FilesModule {}
