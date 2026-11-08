/**
 * Container healthcheck.
 *
 * Docker has no native gRPC probe and the runtime image carries no extra
 * tooling, so this asks grpc.health.v1.Health/Check over the wire using the
 * libraries the service already depends on. Exits 0 only on SERVING.
 *
 * Used by docker-compose.yml as: node dist/healthcheck.js
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { protoPath as healthProtoPath } from 'grpc-health-check';

const PORT = process.env.GRPC_PORT ?? '50051';
const ADDRESS = `127.0.0.1:${PORT}`;
const TIMEOUT_MS = 3000;

interface HealthResponse {
  status: string;
}

function main(): void {
  const definition = protoLoader.loadSync(healthProtoPath, {
    keepCase: false,
    defaults: true,
    oneofs: true,
    enums: String,
  });

  const pkg = grpc.loadPackageDefinition(definition) as unknown as {
    grpc: { health: { v1: { Health: grpc.ServiceClientConstructor } } };
  };

  const client = new pkg.grpc.health.v1.Health(
    ADDRESS,
    grpc.credentials.createInsecure(),
  );

  const finish = (code: number, message: string): void => {
    console.log(message);
    client.close();
    process.exit(code);
  };

  (client as unknown as Record<string, Function>).Check(
    { service: '' },
    { deadline: new Date(Date.now() + TIMEOUT_MS) },
    (error: grpc.ServiceError | null, response: HealthResponse) => {
      if (error) {
        finish(1, `health check failed: ${error.code} ${error.details}`);
        return;
      }

      finish(
        response.status === 'SERVING' ? 0 : 1,
        `health status: ${response.status}`,
      );
    },
  );
}

main();
