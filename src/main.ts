import { Logger as NestLogger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { HermodConfigService } from './config/hermod-config.service';

function installProcessGuards(): void {
  const log = new NestLogger('Process');

  process.on('unhandledRejection', (reason) => {
    log.error(`Unhandled promise rejection (kept alive): ${String(reason)}`);
  });
}

async function bootstrap(): Promise<void> {
  installProcessGuards();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableShutdownHooks();

  const config = app.get(HermodConfigService);

  await app.listen(config.port);
}

void bootstrap();
