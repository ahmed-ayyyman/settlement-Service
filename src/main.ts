import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const configuredOrigins =
    process.env.CORS_ORIGINS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  const corsOrigins =
    configuredOrigins.length > 0
      ? configuredOrigins
      : ['http://localhost:5173', 'http://localhost:5174'];
  app.enableCors({ origin: corsOrigins, credentials: true });

  app.setGlobalPrefix('api');

  const maxUploadMb = Number(process.env.MAX_UPLOAD_SIZE_MB) || 10;
  app.useBodyParser('json', { limit: `${maxUploadMb}mb` });
  app.useBodyParser('urlencoded', {
    limit: `${maxUploadMb}mb`,
    extended: true,
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}
bootstrap().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
