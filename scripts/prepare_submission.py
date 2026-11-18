#!/usr/bin/env python3
"""Rebuild public review artifacts and report gaps without changing curated evidence."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

from check_plugin_submission import inspect
from package_plugin import ROOT, package


def digest(data):
    return hashlib.sha256(data).hexdigest()


def contract_changes(current, baseline):
    current = {t['name']: t for t in current}
    baseline = {t['name']: t for t in baseline}
    return {
        'added': sorted(current.keys() - baseline.keys()),
        'removed': sorted(baseline.keys() - current.keys()),
        'changed': sorted(k for k in current.keys() & baseline.keys() if current[k] != baseline[k]),
    }


def prepare(destination):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    version = json.loads((ROOT / '.codex-plugin/plugin.json').read_text())['version']
    archive = package(destination / f'biocartoon-{version}-public-draft.zip', submission=True)
    validation = inspect(archive)
    (destination / 'package-check.json').write_text(json.dumps(validation, indent=2) + '\n')
    if validation['structural_errors']:
        raise ValueError('; '.join(validation['structural_errors']))
    tools = json.loads((ROOT / 'worker/generated/mcp-metadata.json').read_text())['tools']
    baseline_path = ROOT / 'submission/evidence/live-tools.json'
    baseline = json.loads(baseline_path.read_text()) if baseline_path.exists() else None
    changes = contract_changes(tools, baseline['tools']) if baseline else None
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=normal'], cwd=ROOT, text=True).strip())
    source_files = [ROOT / '.codex-plugin/plugin.json', ROOT / 'mcp.json', ROOT / 'worker/generated/mcp-metadata.json']
    source_files += [p for p in (ROOT / 'catalog/skills').rglob('*') if p.is_file() and not p.is_symlink()]
    source_files += [p for p in (ROOT / 'submission').rglob('*') if p.is_file() and not p.is_symlink()]
    with zipfile.ZipFile(archive) as z:
        skills = sorted(Path(n).parent.name for n in z.namelist() if n.endswith('/SKILL.md'))
    build = {
        'built_at': datetime.now(timezone.utc).isoformat(), 'source_revision': revision,
        'working_tree_dirty': dirty, 'version': version, 'skills': skills,
        'tools': sorted(t['name'] for t in tools),
        'plugin_archive': archive.name, 'plugin_sha256': digest(archive.read_bytes()),
        'missing_package_fields': validation['missing_package_fields'],
        'review_baseline_recorded_at': baseline.get('recorded_at') if baseline else None,
        'review_contract_changes': changes,
        'submission_readiness': 'Not certified; policies, demo, conversational review and portal requirements need human verification.',
        'source_sha256': {p.relative_to(ROOT).as_posix(): digest(p.read_bytes()) for p in sorted(set(source_files))},
    }
    (destination / 'build-info.json').write_text(json.dumps(build, indent=2) + '\n')
    gap_text = ', '.join(validation['missing_package_fields']) or 'None detected in required package fields'
    lines = [
        '# BioCartoon submission build', '',
        f"Source commit: `{revision}`" + (' (local working tree has uncommitted changes)' if dirty else ''), '',
        f'Public draft: `{archive.name}`', '',
        f'Bundled skills: {len(skills)}; declared MCP tools: {len(tools)}.', '',
        'ZIP structural validation: **Passed**.', '',
        f'Missing package fields: **{gap_text}**.', '',
        '## Review evidence', '',
        'Review cases, policy drafts and recordings are maintained by the publisher. This build does not rewrite them or mark cases as passed.', '',
    ]
    if changes is None:
        lines += ['**No recorded tool baseline is available. Review the current contract before submission.**', '']
    elif any(changes.values()):
        lines += ['**Current tools differ from the recorded review baseline. Refresh affected cases, privacy coverage and the demo before submission.**', '']
        lines += [f"- {kind.title()}: {', '.join(names) or 'none'}" for kind, names in changes.items()]
        lines += ['']
    else:
        lines += ['Tool declarations match the recorded baseline. This does not rerun conversational cases or certify the recording.', '']
    lines += ['See `submission/README.md` and `submission/review-results.md` in the review-materials ZIP for remaining manual steps.', '',
              'This job builds artifacts only. It does not upload to OpenAI, submit for review, publish policies, or deploy the server.', '']
    (destination / 'BUILD.md').write_text('\n'.join(lines))
    materials = destination / f'biocartoon-{version}-review-materials.zip'
    with zipfile.ZipFile(materials, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        for p in sorted((ROOT / 'submission').rglob('*')):
            if p.is_file() and not p.is_symlink() and not any(part.startswith('.') for part in p.relative_to(ROOT / 'submission').parts):
                z.write(p, 'biocartoon-review/' + p.relative_to(ROOT).as_posix())
        for p in [archive, destination / 'package-check.json', destination / 'build-info.json', destination / 'BUILD.md']:
            z.write(p, 'biocartoon-review/' + p.name)
    with zipfile.ZipFile(materials) as z:
        assert z.testzip() is None
    return build


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'dist/submission')
    args = parser.parse_args()
    result = prepare(args.output_dir)
    print(json.dumps({k: result[k] for k in ['source_revision', 'plugin_archive', 'plugin_sha256', 'missing_package_fields', 'review_contract_changes']}, indent=2))
