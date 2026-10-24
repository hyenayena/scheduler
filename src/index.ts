import {fileURLToPath} from 'node:url';
import type {ModulePlugin} from '../../../src/api.js';
import {createSchedulerCommand} from './commands.js';
import {noopLog} from './log.js';

// Shell jobs run in the yena root (modules/scheduler/src -> ../../..).
const YENA_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const plugin: ModulePlugin = host => [createSchedulerCommand({dataDir: host.dataDir, cwd: YENA_ROOT, log: host.log ?? noopLog})];

export default plugin;
