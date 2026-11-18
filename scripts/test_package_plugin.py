"""Check separation of the ordinary package and public review draft."""
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from check_plugin_submission import inspect
from package_plugin import ROOT, package


class PackagingTests(unittest.TestCase):
    def test_public_draft_preserves_skills_and_app_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = package(Path(directory) / 'public.zip', submission=True)
            report = inspect(path)
            self.assertEqual(report['structural_errors'], [])
            with zipfile.ZipFile(path) as archive:
                manifest = json.loads(archive.read('biocartoon/plugin.json'))
                openai = manifest['extensions']['com.openai']
                self.assertEqual(openai['review']['test_cases'], json.loads((ROOT / 'submission/review-cases.json').read_text()))
                self.assertEqual(openai['publication']['countries'], [])
                self.assertIs(openai['review']['commerce'], False)
                self.assertEqual(archive.read('biocartoon/assets/logo.png'), (ROOT / 'submission/assets/logo.png').read_bytes())
                self.assertFalse(any('drafts/' in name or 'evidence/' in name for name in archive.namelist()))

    def test_development_package_stays_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = package(Path(directory) / 'development.zip')
            with zipfile.ZipFile(path) as archive:
                manifest = json.loads(archive.read('biocartoon/plugin.json'))
                self.assertNotIn('review', manifest['extensions']['com.openai'])
                expected = {p.parent.name for p in (ROOT / 'catalog/skills').glob('*/SKILL.md')}
                actual = {Path(n).parent.name for n in archive.namelist() if n.endswith('/SKILL.md')}
                self.assertEqual(actual, expected)
                self.assertFalse(any('/assets/' in n for n in archive.namelist()))


if __name__ == '__main__':
    unittest.main()
