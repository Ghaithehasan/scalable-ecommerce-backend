import { ReflectionService } from '@grpc/reflection';
import * as protoLoader from '@grpc/proto-loader';
import { Logger } from '@nestjs/common';
import {
  HealthImplementation,
  protoPath as healthProtoPath,
} from 'grpc-health-check';

const logger = new Logger('GrpcServer');

/**
 * Both libraries declare their own structural type for the same runtime
 * `grpc.Server`, and Nest hands it over as `any`. Deriving each expected type
 * from the method that consumes it keeps the two casts below honest: if either
 * library changes its signature, this stops compiling.
 */
type HealthServer = Parameters<HealthImplementation['addToServer']>[0];
type ReflectionTarget = Parameters<ReflectionService['addToServer']>[0];

/**
 * Keeps the serving status so it can be flipped to NOT_SERVING while the
 * process shuts down, which lets a load balancer drain traffic first.
 */
export const healthImplementation = new HealthImplementation({
  // The empty key is the overall server status, which is what grpcurl reports
  // when no service name is given.
  '': 'SERVING',
  'inventory.v1.InventoryService': 'SERVING',
});

/**
 * Registers the two services every operator expects on a gRPC server but which
 * are not part of the business contract:
 *
 *   grpc.health.v1.Health               liveness and readiness probes, used by
 *                                       the container healthcheck
 *   grpc.reflection.v1.ServerReflection lets grpcurl discover and call the API
 *                                       without a local copy of the .proto
 *
 * The health proto is merged into the package definition handed to the
 * reflection service. Without that merge grpcurl can list the inventory
 * service but cannot describe or call the health service by name.
 */
export function registerGrpcServerExtras(pkg: unknown, server: unknown): void {
  const healthDefinition = protoLoader.loadSync(healthProtoPath, {
    keepCase: false,
    defaults: true,
    oneofs: true,
  });

  healthImplementation.addToServer(server as HealthServer);

  new ReflectionService({
    ...(pkg as protoLoader.PackageDefinition),
    ...healthDefinition,
  }).addToServer(server as ReflectionTarget);

  logger.log('Registered grpc.health.v1.Health and server reflection');
}
