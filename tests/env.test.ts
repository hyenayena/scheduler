import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import type {Logger} from '../../../src/api.js';
import {scriptEnv} from '../src/env.js';
import {noopLog} from '../src/log.js';
import {createRunner, type RunSh} from '../src/runner.js';
import {readRuns, updateJobs} from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'scheduler-env-'));
after(() => rmSync(root, {recursive: true, force: true}));

describe('scriptEnv', () => {
	it('drops credentials, the ssh-agent and URLs with userinfo, keeps the rest', () => {
		const out = scriptEnv({
			PATH: '/bin',
			HOME: '/root',
			LANG: 'C',
			YENA_DATA: '/data',
			ANTHROPIC_API_KEY: 'k',
			CLAUDE_CODE_OAUTH_TOKEN: 't',
			GITHUB_TOKEN: 't',
			AWS_REGION: 'x',
			SSH_AUTH_SOCK: '/run/host-services/ssh-auth.sock',
			SSH_AGENT_PID: '1',
			DATABASE_URL: 'postgres://u:p@h/db',
			MIRROR: 'https://user:pw@example.com/x',
			PLAIN_URL: 'https://example.com',
		});
		assert.deepEqual(Object.keys(out).sort(), ['HOME', 'LANG', 'PATH', 'PLAIN_URL', 'YENA_DATA']);
	});
});

describe('stored run output', () => {
	it('is masked with the host redactors before it is stored', async () => {
		const dataDir = path.join(root, 'd');
		updateJobs(dataDir, s => {
			s.jobs = [{id: 1, when: 'test', createdAt: 0, runs: 0, next: 1, action: {kind: 'sh', script: 'x'}, schedule: {kind: 'once', at: 1}} as never];
			s.nextId = 2;
		});
		const log: Logger = {...noopLog, child: () => log, redact: t => t.split('s3cr3t').join('[redacted]')};
		const sh: RunSh = async () => ({code: 1, output: 'token s3cr3t\n', timedOut: false});
		const r = createRunner({dataDir, cwd: '/', log, bridge: () => undefined, notify: () => {}, now: () => 10, runSh: sh});
		await r.tick();
		await new Promise(res => setTimeout(res, 20));
		r.stop();
		const [run] = readRuns(dataDir, 1);
		assert.equal(run?.output, 'token [redacted]\n');
	});
});
