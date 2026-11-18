#!/usr/bin/env python3
"""Inspect the built public ZIP. Structural validity does not certify public readiness."""
import argparse
import json
from pathlib import Path, PurePosixPath
import struct
from urllib.parse import urlsplit
import zipfile

CATEGORIES = {
    'Business & Operations', 'Communication', 'Creativity', 'Data & Analytics',
    'Developer Tools', 'Education & Research', 'Entertainment', 'Finance',
    'Healthcare', 'Other', 'Productivity', 'Scientific Research', 'Security', 'Travel',
}


def inspect(path):
    errors, missing = [], []

    def check(condition, message):
        if not condition:
            errors.append(message)

    def https(value):
        u = urlsplit(value)
        return u.scheme == 'https' and bool(u.hostname) and not u.username and not u.password and len(value) <= 1024

    with zipfile.ZipFile(path) as archive:
        check(archive.testzip() is None, 'ZIP CRC failure')
        names = archive.namelist()
        check(len(names) == len(set(names)), 'Duplicate archive members')
        for name in names:
            p = PurePosixPath(name)
            check(not p.is_absolute() and '..' not in p.parts and '\\' not in name, f'Unsafe path: {name}')
            check(p.parts[0] == 'biocartoon', f'Unexpected root: {name}')
            check(not any(part.startswith('.') for part in p.parts), f'Hidden packaged file: {name}')
            check(p.name != '.app.json', 'Author uploads must not contain .app.json')
            check((archive.getinfo(name).external_attr >> 16) & 0o170000 != 0o120000, f'Symlink: {name}')
        manifest = json.loads(archive.read('biocartoon/plugin.json'))
        openai = manifest['extensions']['com.openai']
        check(manifest.get('apps') is None and openai.get('apps') is None, 'Private app bindings present')
        check(manifest['$schema'] == 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'Wrong portable schema')
        interface = openai['interface']
        for key, limit in [('displayName', 30), ('shortDescription', 30), ('longDescription', 4000), ('developerName', 80)]:
            check(isinstance(interface.get(key), str) and 0 < len(interface[key]) <= limit, f'Invalid {key}')
        check(interface['category'] in CATEGORIES, 'Unsupported category')
        check('Interactive' in interface.get('capabilities', []), 'Interactive capability lost')
        prompts = interface.get('defaultPrompt', [])
        normalized = [' '.join(p.split()) for p in prompts]
        check(len(prompts) <= 3 and len(set(normalized)) == len(prompts), 'Invalid default prompt count or duplicates')
        check(all(p.strip() and len(p) <= 128 and '\n' not in p and '\r' not in p for p in prompts), 'Invalid default prompt')
        for key in ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']:
            if not interface.get(key):
                missing.append(key)
            else:
                check(https(interface[key]), f'Invalid {key}')
        for key, minimum in [('logo', 256), ('composerIcon', 48)]:
            ref = interface[key]
            check(not PurePosixPath(ref).is_absolute() and '..' not in PurePosixPath(ref).parts, f'Unsafe {key} reference')
            data = archive.read('biocartoon/' + str(PurePosixPath(ref)))
            check(data[:8] == b'\x89PNG\r\n\x1a\n', f'{key} is not PNG')
            width, height = struct.unpack('>II', data[16:24])
            check(width == height and width >= minimum and len(data) <= 5 * 1024 * 1024, f'Invalid {key} dimensions or size')
        skills = sorted(n for n in names if n.endswith('/SKILL.md'))
        check({'biocartoon-find-icons', 'biocartoon-create-icon', 'biocartoon-upload'} <= {PurePosixPath(n).parent.name for n in skills}, 'Required bundled skill missing')
        mcp = json.loads(archive.read('biocartoon/mcp.json'))
        check(set(mcp['mcpServers']) == {'biocartoon'}, 'Unexpected server configuration')
        server = mcp['mcpServers']['biocartoon']
        check(server['url'] == 'https://mcp.biocartoon.com/mcp', 'Wrong hosted endpoint')
        check(server['extensions']['com.openai']['auth']['type'] == 'none', 'Unexpected authentication')
        review = openai['review']
        cases = review['test_cases']
        check(len(cases['positive']) == 5 and len(cases['negative']) == 3, 'Need five positive and three negative cases')
        for kind, items in cases.items():
            for i, case in enumerate(items):
                keys = ['description', 'prompt'] + (['tools_triggered', 'expected_behavior'] if kind == 'positive' else [])
                check(all(isinstance(case.get(k), str) and case[k].strip() for k in keys), f'Invalid {kind} case {i + 1}')
        check(len(review['prompts']) <= 20 and all(isinstance(p, str) and 0 < len(p) <= 4000 for p in review['prompts']), 'Invalid review prompts')
        if not review.get('demo_recording_url'):
            missing.append('demo_recording_url')
        else:
            check(https(review['demo_recording_url']), 'Invalid demo URL')
        if type(review.get('commerce')) is not bool:
            missing.append('commerce declaration')
        publication = openai['publication']
        check(bool(publication.get('release_notes')), 'Release notes absent')
        if 'countries' not in publication:
            missing.append('country targeting')
        check('biocartoon/assets/review-cell.svg' in names, 'Review fixture absent')
    return {'archive': str(Path(path).resolve()), 'structural_errors': errors,
            'missing_package_fields': missing, 'members': names,
            'note': 'URL content, policy coverage, a real demo, live review outcomes and portal checks require separate verification.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--allow-draft', action='store_true', help='Allow explicitly missing submission fields; still reject structural errors')
    args = parser.parse_args()
    result = inspect(args.archive)
    print(json.dumps(result, indent=2))
    raise SystemExit(1 if result['structural_errors'] else (2 if result['missing_package_fields'] and not args.allow_draft else 0))
