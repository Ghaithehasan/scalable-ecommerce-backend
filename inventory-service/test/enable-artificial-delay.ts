/**
 * Side-effect module: turns the artificial delay on before AppModule loads.
 *
 * ConfigModule.forRoot() reads .env at the moment src/app.module.ts is
 * imported, which is hoisted above any beforeAll hook. Setting the variable
 * inside beforeAll is therefore too late. @nestjs/config merges with
 * `{ ...envFile, ...process.env }`, so a value already present in process.env
 * wins - it just has to be there first.
 *
 * Import this BEFORE the harness, and do not reorder the imports.
 */
export const ARTIFICIAL_DELAY_MS = 1500;

process.env.INVENTORY_ARTIFICIAL_DELAY_MS = String(ARTIFICIAL_DELAY_MS);
