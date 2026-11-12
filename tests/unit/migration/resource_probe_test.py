"""Real child-process failures must never become passing resource observations."""
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'scripts/probe/migration'))
from resources import Terminal


@unittest.skipUnless(sys.platform == 'linux', 'requires Linux PTY and util-linux setsid')
class ResourceFailureTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='vesicle-resource-failure-')
        self.root = Path(self.directory.name)
        self.terminal = None

    def tearDown(self):
        if self.terminal is not None:
            self.terminal.close()
        self.directory.cleanup()

    def launch(self, body, output_limit_bytes=65536):
        binary = self.root / 'synthetic-child'
        binary.write_text(f'#!{sys.executable}\n' + body)
        binary.chmod(0o755)
        self.terminal = Terminal(binary, self.root, dict(os.environ), self.root, 'fixture', output_limit_bytes)
        return self.terminal

    def finish(self):
        result = self.terminal.close()
        self.terminal = None
        return result

    def test_child_crash_fails_idle_window_and_retains_exit_status(self):
        terminal = self.launch('import time\ntime.sleep(.1)\nraise SystemExit(17)\n')
        with self.assertRaisesRegex(RuntimeError, 'exited during'):
            terminal.hold(2)
        result = self.finish()
        self.assertEqual(result['exitCode'], 17)
        self.assertFalse(result['forcedCleanup'])
        self.assertTrue((self.root / 'fixture.samples.json').exists())

    def test_output_cap_does_not_repeat_during_cleanup(self):
        terminal = self.launch('import os, time\nos.write(1, b"x" * 16384)\ntime.sleep(20)\n', 1024)
        with self.assertRaisesRegex(RuntimeError, 'output cap'):
            terminal.hold(2)
        child = terminal.child
        result = self.finish()
        self.assertIsNotNone(child.poll())
        self.assertTrue(result['rawTruncated'])
        self.assertEqual(result['cleanupErrors'], [])
        self.assertEqual((self.root / 'fixture.pty').stat().st_size, 1024)

    def test_observation_failure_still_kills_child_and_writes_evidence(self):
        terminal = self.launch('import time\ntime.sleep(20)\n')
        terminal.hold(.1)
        child = terminal.child
        def failed_sampler(**_kwargs):
            raise OSError('injected proc observation failure')
        terminal.tick = failed_sampler
        result = self.finish()
        self.assertIsNotNone(child.poll())
        self.assertTrue(result['cleanupErrors'])
        self.assertTrue((self.root / 'fixture.pty').exists())
        self.assertTrue((self.root / 'fixture.samples.json').exists())


if __name__ == '__main__':
    unittest.main()
