import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { SourceKey } from '../../scrapers/scraper.types';

export const MAX_PROMPT_LENGTH = 8000;
export const MAX_GEO_LENGTH = 64;
export const MAX_SOURCE_LENGTH = 64;

export class CreateQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_SOURCE_LENGTH)
  source!: SourceKey;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PROMPT_LENGTH)
  prompt!: string;

  @IsOptional()
  @IsBoolean()
  parse: boolean = true;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_GEO_LENGTH)
  geo_location?: string;
}
