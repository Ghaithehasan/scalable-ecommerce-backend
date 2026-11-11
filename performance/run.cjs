// Local Docker runner: no seeds, migrations beyond normal startup, or Azure calls.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const mainRoot = path.resolve(__dirname, '..');
const inventoryRoot = path.resolve(mainRoot, '../inventory-service');

function argumentsFor(argv) {
  const result = { profile: argv[0] || 'smoke', build: false };
  const names = {
    '--vus': 'vus',
    '--duration': 'duration',
    '--label': 'label',
    '--min-orders': 'minOrders',
  };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--build' && !result.build) result.build = true;
    else if (names[arg] && argv[index + 1] && !argv[index + 1].startsWith('--'))
      result[names[arg]] = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return result;
}

function dockerExecutable() {
  if (process.env.DOCKER_BIN) return process.env.DOCKER_BIN;
  if (process.platform === 'win32') {
    const candidates = [
      path.join(
        process.env.LOCALAPPDATA || '',
        'Programs/DockerDesktop/resources/bin/docker.exe',
      ),
      'C:/Program Files/Docker/Docker/resources/bin/docker.exe',
    ];
    const found = candidates.find((file) => {
      try {
        return fs.existsSync(file);
      } catch {
        return false;
      }
    });
    if (found) return found;
  }
  return 'docker';
}

function run(docker, args, env, quiet = false) {
  const result = spawnSync(docker, args, {
    cwd: mainRoot,
    env,
    windowsHide: true,
    encoding: 'utf8',
    stdio: quiet ? 'pipe' : 'inherit',
  });
  if (result.error)
    throw new Error(`Cannot execute Docker: ${result.error.message}`);
  if (result.status !== 0) {
    if (quiet && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`Docker command failed with exit ${result.status}`);
  }
  return (result.stdout || '').trim();
}

function runK6(docker, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(docker, args, {
      cwd: mainRoot,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let pending = '';
    let report;
    let invalidReport;
    const line = (value) => {
      if (value.startsWith('K6_REPORT_JSON=')) {
        try {
          report = JSON.parse(value.slice('K6_REPORT_JSON='.length));
        } catch (error) {
          invalidReport = error;
        }
      } else process.stdout.write(value + '\n');
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      lines.forEach(line);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (pending) line(pending);
      if (invalidReport)
        reject(new Error(`Invalid k6 summary: ${invalidReport.message}`));
      else resolve({ code: code ?? 1, report });
    });
  });
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: mainRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function main(argv = process.argv.slice(2)) {
  const args = argumentsFor(argv);
  const localEnv = fs.existsSync(path.join(mainRoot, '.env'))
    ? dotenv.parse(fs.readFileSync(path.join(mainRoot, '.env')))
    : {};
  const password =
    process.env.K6_MANAGER_PASSWORD || localEnv.K6_MANAGER_PASSWORD;
  if (!password)
    throw new Error(
      "Set K6_MANAGER_PASSWORD in your shell or Main's ignored .env",
    );
  const env = {
    ...process.env,
    BASE_URL: 'http://api:3000',
    K6_MANAGER_PASSWORD: password,
    K6_MANAGER_EMAIL:
      process.env.K6_MANAGER_EMAIL ||
      localEnv.K6_MANAGER_EMAIL ||
      'perf.v1.manager@example.com',
    K6_PROFILE: args.profile,
    ORDERS_VUS: args.vus || '5',
    ORDERS_DURATION: args.duration || '30s',
    K6_MIN_ORDERS: args.minOrders || '1000',
    K6_LABEL: args.label || 'before-small',
  };
  const { configuration } = await import('./orders-contract.mjs');
  const config = configuration(env);
  const base = [
    'compose',
    '--project-directory',
    inventoryRoot,
    '-f',
    path.join(inventoryRoot, 'compose.local.yaml'),
  ];
  const overlay = [
    ...base,
    '-f',
    path.join(inventoryRoot, 'compose.performance.yaml'),
  ];
  if (!fs.existsSync(overlay[overlay.length - 1]))
    throw new Error('Missing Inventory compose.performance.yaml');
  const docker = dockerExecutable();
  const resultsRoot = path.join(mainRoot, 'performance/results');
  fs.mkdirSync(resultsRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultFile = path.join(
    resultsRoot,
    `${stamp}-${config.profile}-${config.label}.json`,
  );
  let performanceStarted = false;
  let failure;
  try {
    run(docker, [...overlay, 'config', '--quiet'], env);
    if (args.build) run(docker, [...overlay, 'build', 'main-migrate'], env);
    performanceStarted = true;
    run(
      docker,
      [...overlay, 'up', '-d', '--wait', '--wait-timeout', '120', 'api'],
      env,
    );
    const cachedK6 = spawnSync(
      docker,
      ['image', 'inspect', 'grafana/k6:2.3.0'],
      { env, windowsHide: true, stdio: 'ignore' },
    );
    if (cachedK6.status !== 0) {
      console.log('Downloading pinned k6 image (first run only)...');
      run(docker, [...overlay, 'pull', '--quiet', 'k6'], env);
    }
    const apiId = run(docker, [...base, 'ps', '-q', 'api'], env, true);
    const apiImage = run(
      docker,
      ['inspect', '--format', '{{.Image}}', apiId],
      env,
      true,
    );
    const { code, report } = await runK6(
      docker,
      [...overlay, 'run', '--rm', '-T', '--no-deps', 'k6'],
      env,
    );
    const result = report || {
      schemaVersion: 1,
      valid: false,
      error: 'k6 did not produce a summary; see startup/setup error above',
      workload: config,
    };
    result.valid = code === 0 && result.valid === true;
    result.environment = {
      appCommit: git(['rev-parse', 'HEAD']),
      worktreeDirty: Boolean(git(['status', '--porcelain'])),
      apiImage,
      k6Image: 'grafana/k6:2.3.0',
      platform: os.platform(),
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      hostMemoryGiB: Math.round(os.totalmem() / 1024 ** 3),
      endpoint: 'api:3000 over the local Compose network',
    };
    result.k6ExitCode = code;
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n');
    console.log(`Report: ${resultFile}`);
    if (!result.valid)
      throw new Error(
        'Invalid benchmark: failed checks, missing samples or k6 failure; do not use it as a performance result',
      );
  } catch (error) {
    failure = error;
  } finally {
    if (performanceStarted) {
      try {
        run(
          docker,
          [
            ...base,
            'up',
            '-d',
            '--no-deps',
            '--wait',
            '--wait-timeout',
            '60',
            'api',
          ],
          env,
        );
        console.log(
          'Restored the normal local API configuration; application containers remain running.',
        );
      } catch (error) {
        console.error(
          'Could not restore normal API configuration. Run docker compose -f compose.local.yaml up -d --no-deps --wait api from Inventory.',
        );
        failure = failure || error;
      }
    }
  }
  if (failure) throw failure;
}

module.exports = { argumentsFor };
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
