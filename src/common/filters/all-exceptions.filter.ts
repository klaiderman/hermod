import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { ErrorCode } from '../errors/error-codes';
import { PartialResponseError, ScraperError } from '../errors/scraper-errors';

type RequestWithId = Request & { id?: string };

interface ErrorBody {
  error: { code: ErrorCode | string; message: string; retryable: boolean };
  meta: { request_id: string };
  partial?: { response_text: string; markdown_text: string };
}

interface ErrorResult {
  status: number;
  body: ErrorBody;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithId>();
    const requestId = request.id ?? 'unknown';

    const { status, body } = this.toResult(exception, requestId);

    if (status >= 500) {
      this.logger.error({ requestId, err: exception, errorCode: body.error.code }, 'request failed');
    } else {
      this.logger.warn({ requestId, errorCode: body.error.code, status }, 'request rejected');
    }

    response.status(status).json(body);
  }

  private toResult(exception: unknown, requestId: string): ErrorResult {
    if (exception instanceof ScraperError) {
      const body: ErrorBody = {
        error: { code: exception.errorCode, message: exception.message, retryable: exception.retryable },
        meta: { request_id: requestId },
      };

      if (exception instanceof PartialResponseError) {
        body.partial = {
          response_text: exception.salvage.response_text,
          markdown_text: exception.salvage.markdown_text,
        };
      }

      return { status: exception.httpStatus, body };
    }

    if (exception instanceof BadRequestException) {
      return this.simple(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_REQUEST,
        extractValidationMessage(exception),
        requestId,
      );
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.INVALID_REQUEST;

      return this.simple(status, code, exception.message, requestId);
    }

    return this.simple(
      HttpStatus.INTERNAL_SERVER_ERROR,
      ErrorCode.INTERNAL_ERROR,
      'An internal error occurred.',
      requestId,
    );
  }

  private simple(status: number, code: ErrorCode, message: string, requestId: string): ErrorResult {
    return {
      status,
      body: { error: { code, message, retryable: false }, meta: { request_id: requestId } },
    };
  }
}

function extractValidationMessage(exception: BadRequestException): string {
  const res = exception.getResponse();

  if (typeof res === 'object' && res !== null && 'message' in res) {
    const msg = (res as { message: unknown }).message;

    if (Array.isArray(msg)) {
      return msg.join('; ');
    }

    if (typeof msg === 'string') {
      return msg;
    }
  }

  return 'Validation failed.';
}
