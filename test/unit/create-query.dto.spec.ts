import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateQueryDto, MAX_PROMPT_LENGTH } from '../../src/queries/dto/create-query.dto';

describe('CreateQueryDto validation', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const meta: ArgumentMetadata = { type: 'body', metatype: CreateQueryDto };

  const run = (body: unknown) => pipe.transform(body, meta);

  it('accepts a valid request and defaults parse=true', async () => {
    const out = await run({ source: 'chatgpt', prompt: 'hello' });

    expect(out).toMatchObject({ source: 'chatgpt', prompt: 'hello', parse: true });
  });

  it('accepts any non-empty source string; the registry decides support', async () => {
    const out = await run({ source: 'claude', prompt: 'hi' });

    expect(out).toMatchObject({ source: 'claude' });
  });

  it('rejects an empty source', async () => {
    await expect(run({ source: '', prompt: 'hi' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an empty prompt', async () => {
    await expect(run({ source: 'chatgpt', prompt: '' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an over-long prompt (DoS control)', async () => {
    await expect(run({ source: 'chatgpt', prompt: 'x'.repeat(MAX_PROMPT_LENGTH + 1) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a smuggled non-whitelisted field', async () => {
    await expect(run({ source: 'chatgpt', prompt: 'hi', executablePath: '/evil' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts an optional geo_location', async () => {
    const out = await run({ source: 'chatgpt', prompt: 'hi', geo_location: 'US' });

    expect(out).toMatchObject({ geo_location: 'US' });
  });
});
