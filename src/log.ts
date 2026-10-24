import type {Logger} from '../../../src/api.js';

export const noopLog: Logger = {
	error: () => {},
	warn: () => {},
	info: () => {},
	debug: () => {},
	child: () => noopLog,
	addRedactor: () => {},
};
