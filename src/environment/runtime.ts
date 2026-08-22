import { Environment } from './environment.types';
import { createDefaultEnvironment } from './defaults';
import { deepMerge } from '../utils/deepMerge';

/**
 * The process-wide, mutable environment singleton.
 *
 * Every module imports this (`import environment from '.../environment/runtime'`)
 * and reads it lazily, so a host application — the CLI, the desktop app, or a
 * library consumer — can call `configureEnvironment()` before `new Application()`
 * and have the whole tree see the merged result.
 *
 * It starts life as a *copy* of `DEFAULT_ENVIRONMENT`, never the object itself,
 * so mutating the runtime config can never contaminate the defaults.
 */
const environment: Environment = createDefaultEnvironment();

/**
 * Override environment settings. Call BEFORE creating an `Application`.
 * Overrides are deep-merged, so a partial block (e.g. just `api.port`) leaves
 * the rest of that block at its default.
 */
export function configureEnvironment(overrides: Partial<Environment>): void {
  Object.assign(environment, deepMerge(environment, overrides));
}

export default environment;
