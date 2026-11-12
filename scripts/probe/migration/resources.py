#!/usr/bin/env python3
"""Linux/WSL release measurements; retains raw samples and never calls a live model.

python3 scripts/probe/migration/resources.py <binary> <new-output-dir> <TS-SHA>
Requires Python 3.11+, Linux /proc, util-linux setsid and a built standalone binary.
"""
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import pty
import re
import select
import signal
import statistics
import struct
import subprocess
import sys
import termios
import time

from local_provider import Provider


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def plain(raw):
    text = raw.decode('utf-8', errors='replace')
    text = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', text)
    text = re.sub(r'\x1b\[[0-9:;<=>?]*[ -/]*[@-~]', '', text)
    return text


def process_tree(pid):
    rows = {}
    for path in Path('/proc').glob('[0-9]*/status'):
        try:
            fields = dict(line.split(':', 1) for line in path.read_text().splitlines() if ':' in line)
            rows[int(path.parent.name)] = {
                'pid': int(path.parent.name), 'ppid': int(fields['PPid']),
                'name': fields['Name'].strip(),
                'rssKiB': int(fields.get('VmRSS', '0 kB').split()[0]),
                'hwmKiB': int(fields.get('VmHWM', '0 kB').split()[0]),
            }
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    selected = {pid}
    while True:
        expanded = selected | {p for p, row in rows.items() if row['ppid'] in selected}
        if expanded == selected:
            break
        selected = expanded
    return [rows[p] for p in sorted(selected) if p in rows]


class Terminal:
    def __init__(self, binary, project, env, output, name, output_limit_bytes=64 * 1024 * 1024):
        self.raw = bytearray()
        self.raw_truncated = False
        self.output_limit_bytes = output_limit_bytes
        self.samples = []
        self.phase = 'startup'
        self.started = time.monotonic()
        self.output, self.name = output, name
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 28, 100, 0, 0))
        # setsid acquires the controlling PTY in native code. Python preexec_fn
        # is unsafe here because the synthetic HTTP server already has threads.
        self.child = subprocess.Popen(['setsid', '--ctty', '--wait', str(binary), str(project)],
                                      stdin=slave, stdout=slave, stderr=slave, env=env)
        os.close(slave)
        self.last_sample = 0

    def tick(self, enforce_cap=True):
        if select.select([self.master], [], [], .05)[0]:
            try:
                chunk = os.read(self.master, 65536)
                room = max(0, self.output_limit_bytes - len(self.raw))
                self.raw.extend(chunk[:room])
                self.raw_truncated |= len(chunk) > room
            except OSError:
                pass
        now = time.monotonic()
        if now - self.last_sample >= .1:
            rows = process_tree(self.child.pid)
            self.samples.append({'seconds': now - self.started, 'phase': self.phase,
                                 'treeRssKiB': sum(row['rssKiB'] for row in rows), 'processes': rows})
            self.last_sample = now
        if enforce_cap and self.raw_truncated:
            raise RuntimeError('PTY output cap exceeded')

    def wait(self, predicate, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.tick()
            if self.child.poll() is not None:
                raise RuntimeError(f'TUI exited during {self.phase} observation')
            if predicate():
                return (time.monotonic() - self.started) * 1000
        raise RuntimeError(f'PTY observation timeout in {self.phase}')

    def hold(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.tick()
            if self.child.poll() is not None:
                raise RuntimeError(f'TUI exited during {self.phase} observation')

    def send(self, text):
        os.write(self.master, text.encode())

    def command(self, text):
        self.send(text)
        self.hold(.1)
        self.send('\r')

    def ready(self):
        frame_ms = self.wait(lambda: 'etl' in plain(self.raw).lower())
        # Require raw-mode input handling; otherwise PTY kernel echo could give
        # a false "interactive" observation before the app is actually ready.
        self.wait(lambda: not termios.tcgetattr(self.master)[3] & termios.ECHO)
        self.send('INPUT_READY_PROBE')
        interactive_ms = self.wait(lambda: 'INPUT_READY_PROBE' in plain(self.raw))
        self.send('\x7f' * len('INPUT_READY_PROBE'))
        self.hold(.3)
        return {'firstObservedFrameMs': frame_ms, 'inputEchoReadyMs': interactive_ms}

    def close(self):
        self.phase = 'exit'
        started = time.monotonic()
        errors = []
        forced = False
        code = self.child.poll()
        try:
            if code is None:
                self.send('\x03')
                deadline = time.monotonic() + .3
                while self.child.poll() is None and time.monotonic() < deadline:
                    self.tick(enforce_cap=False)
                if self.child.poll() is None:
                    self.send('\x03')
                deadline = time.monotonic() + 10
                while self.child.poll() is None and time.monotonic() < deadline:
                    self.tick(enforce_cap=False)
        except BaseException as error:
            errors.append(f'{type(error).__name__}: {error}')
        finally:
            forced = self.child.poll() is None
            if forced:
                try:
                    os.killpg(self.child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except OSError as error:
                    errors.append(str(error))
                    self.child.kill()
            try:
                code = self.child.wait(timeout=5)
                self.tick(enforce_cap=False)
            except BaseException as error:
                errors.append(f'{type(error).__name__}: {error}')
            finally:
                os.close(self.master)
                (self.output / f'{self.name}.pty').write_bytes(self.raw)
                (self.output / f'{self.name}.samples.json').write_text(json.dumps(self.samples, indent=2) + '\n')
        return {'exitCode': code, 'forcedCleanup': forced, 'cleanupErrors': errors, 'rawTruncated': self.raw_truncated,
                'exitObservedMs': (time.monotonic() - started) * 1000}


def environment(config, port):
    config.mkdir()
    (config / 'providers.yaml').write_text(f'''default:
  provider: fixture
  model: fixture-model
providers:
  fixture:
    protocol: openai-chat-compatible
    baseUrl: http://127.0.0.1:{port}/v1
    apiKeyEnv: RESOURCE_FIXTURE_KEY
    models:
      - id: fixture-model
        limits:
          contextWindow: 1000000
''')
    (config / '.env').write_text('RESOURCE_FIXTURE_KEY=synthetic-fixture-key\n')
    (config / 'settings.yaml').write_text('version: 1\nsessionTitle: off\n')
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'TMPDIR') if key in os.environ}
    env.update(TERM='xterm-256color', VESICLE_REDUCED_MOTION='1', VESICLE_CONFIG_DIR=str(config),
               VESICLE_PROVIDERS_FILE=str(config / 'providers.yaml'), VESICLE_SETTINGS_FILE=str(config / 'settings.yaml'),
               VESICLE_MCP_FILE=str(config / 'absent-mcp.yaml'), VESICLE_QUALITY_FILE=str(config / 'absent-quality.yaml'),
               VESICLE_PERMISSIONS_FILE=str(config / 'absent-permissions.yaml'))
    return env


def seed_long_session(project):
    files = list((project / '.vesicle/sessions').glob('*.jsonl'))
    if len(files) != 1:
        raise RuntimeError('expected exactly one probe session')
    path = files[0]
    records = [json.loads(line) for line in path.read_text().splitlines() if line]
    # Keep the first completed interaction; cancellation is sampled separately.
    for index, record in enumerate(records):
        if record['role'] == 'user' and 'cancel-probe' in record['content']:
            records = records[:index]
            break
    parent = records[-1]['uuid']
    for index in range(1000):
        for role in ('user', 'assistant'):
            uuid = f'long-{index}-{role}'
            records.append({'uuid': uuid, 'parentUuid': parent, 'ts': '2026-01-01T00:00:00.000Z',
                            'sessionId': path.stem, 'role': role,
                            'content': 'LONG-LAST' if index == 999 and role == 'assistant' else f'{role} {index}: ' + 'synthetic 中文 history. ' * 12})
            parent = uuid
    path.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in records))
    return path.stem, len(records), path.stat().st_size, sum(row['role'] in ('user', 'assistant') for row in records)


def main():
    binary, output, sha = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), sys.argv[3]
    if sys.platform != 'linux':
        raise RuntimeError('unavailable: Linux /proc and PTY required; native Windows is separate')
    actual_sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=binary.parent, text=True).strip()
    dirty = subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=binary.parent, text=True)
    if actual_sha != sha or dirty:
        raise RuntimeError('binary must be built in the clean checkout of the declared TS SHA')
    output.mkdir(parents=True, exist_ok=False)
    project = output / 'project'
    project.mkdir()
    provider = Provider()
    terminal = None
    cpu_fields = dict(line.split(':', 1) for line in Path('/proc/cpuinfo').read_text().splitlines() if ':' in line)
    mem_fields = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines() if ':' in line)
    result = {'schemaVersion': 1, 'status': 'failed', 'tsSha': sha, 'binarySha256': digest(binary),
              'binaryBytes': binary.stat().st_size, 'environment': platform.platform(),
              'binaryGzipBytes': len(gzip.compress(binary.read_bytes(), mtime=0)),
              'cpu': cpu_fields.get('model name\t', platform.processor()).strip(), 'logicalCpus': os.cpu_count(),
              'systemMemoryKiB': int(mem_fields['MemTotal'].split()[0]),
              'sourceHashes': {name: digest(binary.parent / name) for name in ('package.json', 'bun.lock', 'harness-manifest.json')},
              'scriptHashes': {name: digest(Path(__file__).parent / name) for name in ('resources.py', 'local_provider.py')},
              'python': platform.python_version(), 'terminal': '100x28 xterm-256color',
              'sampleIntervalMs': 100, 'idleObservationSeconds': 20, 'longSyntheticTurns': 1000,
              'limitations': ['warm runs; no page-cache flush', 'local deterministic provider; MCP disabled',
                              'sampled RSS sum can double-count shared pages; not PSS', 'native Windows/macOS unavailable here',
                              'frame markers are observations, not instrumented render timestamps']}
    try:
        env = environment(output / 'config', provider.port)
        version_runs = []
        for _ in range(5):
            start = time.monotonic()
            completed = subprocess.run([str(binary), '--version'], env=env, capture_output=True, timeout=10, check=True)
            version_runs.append({'wallMs': (time.monotonic() - start) * 1000, 'stdout': completed.stdout.decode()})
        result['versionRuns'] = version_runs
        terminal = Terminal(binary, project, env, output, 'interactive')
        result['startup'] = terminal.ready()
        terminal.phase = 'empty-idle'
        terminal.hold(20)
        terminal.phase = 'stream'
        start = time.monotonic()
        terminal.command('stream-probe')
        terminal.wait(lambda: 'STREAM_BEGIN' in plain(terminal.raw))
        result['streamFirstObservedMs'] = (time.monotonic() - start) * 1000
        terminal.wait(lambda: 'STREAM_END' in plain(terminal.raw))
        result['streamCompletedMs'] = (time.monotonic() - start) * 1000
        terminal.hold(1)
        terminal.phase = 'cancel'
        terminal.command('cancel-probe')
        terminal.wait(lambda: 'CANCEL_BEGIN' in plain(terminal.raw))
        start = time.monotonic()
        terminal.send('\x1b')
        terminal.wait(provider.cancel_closed.is_set, 10)
        result['cancelConnectionClosedMs'] = (time.monotonic() - start) * 1000
        terminal.send('CANCEL_INPUT_READY')
        terminal.wait(lambda: 'CANCEL_INPUT_READY' in plain(terminal.raw))
        result['cancelInputObservedMs'] = (time.monotonic() - start) * 1000
        terminal.send('\x7f' * len('CANCEL_INPUT_READY'))
        terminal.hold(1)
        result['interactiveExit'] = terminal.close()
        terminal = None
        # Preserve the actual streamed/cancelled records before synthetic history.
        session = next((project / '.vesicle/sessions').glob('*.jsonl'))
        (output / 'observed-session.jsonl').write_bytes(session.read_bytes())
        session_id, count, size, prior = seed_long_session(project)
        result['longHistory'] = {'records': count, 'bytes': size, 'sessionId': session_id, 'projectedMessages': prior}
        terminal = Terminal(binary, project, env, output, 'long')
        terminal.ready()
        terminal.phase = 'long-resume'
        start = time.monotonic()
        terminal.command('/resume ' + session_id)
        # Resume notices occupy the bottom viewport, hiding the last historical
        # answer. Observe the host's restored message count, not off-screen text.
        terminal.wait(lambda: 'Resumed session' in plain(terminal.raw) and f'{prior} prior' in plain(terminal.raw))
        result['longResumeObservedMs'] = (time.monotonic() - start) * 1000
        terminal.phase = 'long-idle'
        terminal.hold(20)
        result['longExit'] = terminal.close()
        terminal = None
        if provider.errors or len(provider.requests) != 2:
            raise RuntimeError(f'provider request contract failed: {provider.errors}; count={len(provider.requests)}')
        if any(result[key]['forcedCleanup'] or result[key]['exitCode'] != 0 or result[key]['cleanupErrors'] or result[key]['rawTruncated'] for key in ('interactiveExit', 'longExit')):
            raise RuntimeError('TUI did not exit cleanly')
        result['status'] = 'passed'
    except BaseException as error:
        result['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        try:
            if terminal:
                result['failureExit'] = terminal.close()
        finally:
            try:
                provider.close()
            finally:
                result['requestCount'] = len(provider.requests)
                (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
                (output / 'wire.json').write_text(json.dumps(provider.requests, indent=2, ensure_ascii=False) + '\n')
    summaries = {}
    for name in ('interactive', 'long'):
        samples = json.loads((output / f'{name}.samples.json').read_text())
        for phase in sorted({row['phase'] for row in samples}):
            values = [row['treeRssKiB'] for row in samples if row['phase'] == phase and row['treeRssKiB'] > 0]
            if values:
                summaries[name + ':' + phase] = {'samples': len(values), 'medianTreeRssKiB': statistics.median(values), 'peakSampledTreeRssKiB': max(values)}
    (output / 'summary.json').write_text(json.dumps(summaries, indent=2) + '\n')
    manifest = {str(path.relative_to(output)): digest(path) for path in sorted(output.rglob('*')) if path.is_file()}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'output': str(output), 'measurements': summaries}, indent=2))


if __name__ == '__main__':
    main()
