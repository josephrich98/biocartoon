import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from package_plugin import ROOT
from prepare_submission import contract_changes, prepare


class SubmissionBuildTests(unittest.TestCase):
    def test_drift_reports_additions_removals_and_schema_changes(self):
        self.assertEqual(contract_changes(
            [{'name': 'new'}, {'name': 'changed', 'inputSchema': {'type': 'object'}}],
            [{'name': 'old'}, {'name': 'changed', 'inputSchema': {}}],
        ), {'added': ['new'], 'removed': ['old'], 'changed': ['changed']})

    def test_build_provenance_and_curated_evidence_are_preserved(self):
        curated = [ROOT / 'submission/review-cases.json', ROOT / 'submission/review-results.md', ROOT / 'submission/evidence/live-tools.json']
        before = {p: p.read_bytes() for p in curated}
        with tempfile.TemporaryDirectory() as directory:
            build = prepare(directory)
            archive = Path(directory) / build['plugin_archive']
            self.assertEqual(build['plugin_sha256'], hashlib.sha256(archive.read_bytes()).hexdigest())
            self.assertIn('biocartoon-make-figure', build['skills'])
            self.assertIn('termsOfServiceURL', build['missing_package_fields'])
            self.assertEqual(len(build['source_revision']), 40)
            materials = next(Path(directory).glob('*review-materials.zip'))
            with zipfile.ZipFile(materials) as z:
                self.assertIn('biocartoon-review/build-info.json', z.namelist())
                self.assertEqual(z.read('biocartoon-review/submission/review-cases.json'), before[curated[0]])
            info = json.loads((Path(directory) / 'build-info.json').read_text())
            self.assertEqual(info, build)
        self.assertEqual({p: p.read_bytes() for p in curated}, before)


if __name__ == '__main__':
    unittest.main()
