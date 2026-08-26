import { plainToInstance, Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUrl, Min, validateSync } from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

const toInt = ({ value }: { value: unknown }): unknown =>
  value === undefined || value === '' ? undefined : Number(value);

const toBool = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 'true' || value === '1') {
    return true;
  }

  if (value === 'false' || value === '0') {
    return false;
  }

  return value;
};

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  @IsOptional()
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @IsOptional()
  PORT = 3000;

  @IsString()
  @IsOptional()
  LOG_LEVEL = 'info';

  @IsUrl({ require_tld: false })
  CHATGPT_BASE_URL!: string;

  @IsString()
  @IsOptional()
  BROWSER_EXECUTABLE_PATH = '';

  @Transform(toBool)
  @IsBoolean()
  @IsOptional()
  HEADLESS = false;

  @Transform(toBool)
  @IsBoolean()
  @IsOptional()
  HEADFUL_OFFSCREEN = false;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @IsOptional()
  POOL_MAX = 3;

  @Transform(toInt)
  @IsInt()
  @Min(0)
  @IsOptional()
  POOL_MIN = 0;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @IsOptional()
  POOL_ACQUIRE_TIMEOUT_MS = 10000;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @IsOptional()
  CONTEXT_MAX_USES = 15;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @IsOptional()
  NAV_TIMEOUT_MS = 30000;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @IsOptional()
  FIRST_BYTE_MS = 15000;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @IsOptional()
  IDLE_MS = 20000;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @IsOptional()
  WALL_CLOCK_MS = 120000;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @IsOptional()
  RETRY_MAX_ATTEMPTS = 3;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @IsOptional()
  BACKOFF_INITIAL_MS = 500;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @IsOptional()
  BACKOFF_MAX_MS = 8000;

  @IsString()
  @IsOptional()
  PROXY_URL = '';
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
  });
  const errors = validateSync(validated, {
    skipMissingProperties: false,
    forbidUnknownValues: false,
  });

  if (errors.length > 0) {
    const detail = errors.map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`).join('\n  ');

    throw new Error(`Invalid environment configuration:\n  ${detail}`);
  }

  return validated;
}
