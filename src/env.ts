const SECRET_NAMES = [
	/^AWS_|TOKEN|SECRET|PASSW|API_?KEY|CREDENTIAL/i,
	/PRIVATE|COOKIE|AUTH/i,
	/.PWD$/i,
	/^DATABASE_URL$|_DSN$|_URI$|_CONNECTION_STRING$/i,
	/(ACCESS|SIGNING)_?KEY/i,
	/_SK$/i,
	/(^|_)DEPLOY_?KEY/i,
	/WEBHOOK|SIGNING|BEARER/i,
	/ENCRYPTION_?KEY|MASTER_?KEY|SESSION_?(KEY|SECRET)/i,
];

const SSH_AGENT = new Set(['SSH_AUTH_SOCK', 'SSH_AGENT_PID']);

const SAFE_NAME =
	/^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|TERM|COLORTERM|LANG|LANGUAGE|TZ|TMPDIR|TEMP|TMP|NO_COLOR|FORCE_COLOR|HOSTNAME|NODE_ENV|EDITOR|PAGER|SHLVL|_)$|^LC_/;

const SCAN_MAX = 8192;

function hasUserinfo(value: string): boolean {
	const v = value.length > SCAN_MAX ? value.slice(0, SCAN_MAX) : value;
	let i = v.indexOf('://');
	while (i !== -1) {
		let j = i + 3;
		while (j < v.length && !/[\s/@?#]/.test(v[j] as string)) j++;
		if (j > i + 3 && v[j] === '@') return true;
		i = v.indexOf('://', i + 3);
	}
	return false;
}

export function scriptEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(env)) {
		if (SAFE_NAME.test(name)) out[name] = value;
		else if (SSH_AGENT.has(name) || SECRET_NAMES.some(re => re.test(name)) || (typeof value === 'string' && hasUserinfo(value))) continue;
		else out[name] = value;
	}
	return out;
}
