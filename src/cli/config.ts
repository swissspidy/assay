/**
 * The config file for the CLI (ADR 0017): `--config <path>`, else assay.config.{ts,mts,js,mjs}
 * in the current directory. Flags win over environment variables, which win over the
 * config, which wins over built-in defaults.
 */
import { ConfigError, loadConfig, type LoadedConfig } from '../config/config.ts';
import { CliError, type Io, type Values } from './io.ts';

export async function cliConfig(values: Values, io: Io): Promise<LoadedConfig> {
  const path = typeof values.config === 'string' ? values.config : undefined;
  try {
    return await loadConfig({ cwd: io.cwd ?? process.cwd(), ...(path !== undefined ? { path } : {}) });
  } catch (e) {
    if (e instanceof ConfigError) throw new CliError(e.message);
    throw e;
  }
}

/** A config value wrapped for the CLI: a config error is a CliError (exit 4). */
export function fromConfig<T>(read: () => T): T {
  try {
    return read();
  } catch (e) {
    if (e instanceof ConfigError) throw new CliError(e.message);
    throw e;
  }
}
