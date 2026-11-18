#!/usr/bin/env python3
"""Build a portable plugin from the compatibility manifest and canonical skills.

--submission adds the public listing/review drafts without altering the private package.
No account upload, server deployment, or public listing is performed.
"""
import argparse
import copy
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def package(destination=None, *, submission=False):
    legacy = json.loads((ROOT / '.codex-plugin/plugin.json').read_text())
    manifest = {k: v for k, v in legacy.items() if k not in ('skills', 'mcpServers', 'interface')}
    manifest['$schema'] = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
    openai = manifest.setdefault('extensions', {}).setdefault('com.openai', {})
    openai['interface'] = copy.deepcopy(legacy['interface'])
    if submission:
        listing = json.loads((ROOT / 'submission/listing.json').read_text())
        openai['interface'].update(listing['interface'])
        for section in ('review', 'publication'):
            openai[section] = copy.deepcopy(listing[section])
        openai['review']['test_cases'] = json.loads((ROOT / 'submission/review-cases.json').read_text())
    interface = manifest['extensions']['com.openai']['interface']
    assert len(interface['shortDescription']) <= 30
    mcp = json.loads((ROOT / 'mcp.json').read_text())
    assert mcp['mcpServers']['biocartoon']['url'] == 'https://mcp.biocartoon.com/mcp'
    assert 'Interactive' in interface['capabilities']
    tools = json.loads((ROOT / 'worker/generated/mcp-metadata.json').read_text())['tools']
    assert {'render_assets', 'search_assets', 'submit_artwork'} <= {t['name'] for t in tools}
    assert next(t for t in tools if t['name'] == 'render_assets')['_meta']['ui']['resourceUri'].startswith('ui://biocartoon/')
    skills = ROOT / legacy['skills']
    files = {f'skills/{p.relative_to(skills).as_posix()}': p.read_bytes() for p in sorted(skills.rglob('*')) if p.is_file() and not p.is_symlink() and not any(part.startswith('.') for part in p.relative_to(skills).parts)}
    packaged_skills = {Path(p).parent.name for p in files if p.endswith('/SKILL.md')}
    assert {'biocartoon-find-icons', 'biocartoon-create-icon', 'biocartoon-upload'} <= packaged_skills
    if submission:
        assets = ROOT / 'submission/assets'
        for p in sorted(assets.rglob('*')):
            if p.is_file() and not p.is_symlink() and not any(part.startswith('.') for part in p.relative_to(assets).parts):
                files[f'assets/{p.relative_to(assets).as_posix()}'] = p.read_bytes()
    files['plugin.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    files['mcp.json'] = (json.dumps(mcp, indent=2) + '\n').encode()
    suffix = '-public-draft' if submission else ''
    destination = Path(destination) if destination else ROOT / 'dist' / f"biocartoon-{manifest['version']}{suffix}.zip"
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, body in sorted(files.items()):
            archive.writestr(f'biocartoon/{name}', body)
    with zipfile.ZipFile(destination) as archive:
        assert archive.testzip() is None
        packaged = json.loads(archive.read('biocartoon/plugin.json'))
        assert packaged['extensions']['com.openai']['interface']['defaultPrompt'] == legacy['interface']['defaultPrompt']
        assert all(not Path(p).is_absolute() and '..' not in Path(p).parts for p in archive.namelist())
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--submission', action='store_true', help='Include public listing and review materials; does not certify readiness')
    parser.add_argument('--output', type=Path, help='Optional destination ZIP')
    args = parser.parse_args()
    print(package(args.output, submission=args.submission))
