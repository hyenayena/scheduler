import type {ModulePlugin} from '../../../src/api.js';
import {createSchedulerCommand} from './commands.js';
import {noopLog} from './log.js';

const plugin: ModulePlugin = host => [createSchedulerCommand({dataDir: host.dataDir, cwd: host.build?.root?.path ?? process.cwd(), log: host.log ?? noopLog})];

export default plugin;
