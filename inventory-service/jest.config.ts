import type { Config } from 'jest';

/**
 * The suites boot the real microservice and talk to a real PostgreSQL
 * database, so they run one at a time: parallel workers would compete for the
 * same stock rows and for the same ports.
 */
const config: Config = {
  rootDir: '.',
  roots: ['<rootDir>/test'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\.e2e-spec\.ts$',
  transform: {
    '^.+\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.spec.json' }],
  },
  testEnvironment: 'node',
  maxWorkers: 1,
  testTimeout: 60000,
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: './coverage',
};

export default config;
