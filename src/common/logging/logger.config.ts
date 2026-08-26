import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Options } from 'pino-http';
import { Params } from 'nestjs-pino';
import { HermodConfigService } from '../../config/hermod-config.service';

export function buildLoggerParams(config: HermodConfigService): Params {
  const isProd = config.nodeEnv === 'production';
  const pinoHttp: Options = {
    level: config.logLevel,
    genReqId: (req: IncomingMessage, res: ServerResponse): string => {
      const inbound = req.headers['x-request-id'];
      const id = typeof inbound === 'string' && inbound.length > 0 ? inbound : randomUUID();

      res.setHeader('X-Request-Id', id);

      return id;
    },

    autoLogging: true,
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      remove: true,
    },
    serializers: {
      req(req: { method: string; url: string; id: string }) {
        return { id: req.id, method: req.method, url: req.url };
      },
    },
  };

  if (!isProd) {
    pinoHttp.transport = { target: 'pino-pretty', options: { singleLine: true } };
  }

  return { pinoHttp };
}
