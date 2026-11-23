#!/usr/bin/env python3
"""Build the Claude plugin package and per-skill zips from the repo's Claude plugin manifest.

dist/biocartoon-claude-VERSION.zip: the plugin (manifest, skills, hosted MCP connection), for the
Claude apps' plugin upload or directory submission. dist/claude-skills/NAME.zip: one zip per skill,
for Settings > Capabilities > Skills. Nothing is uploaded.
"""
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def skill_files(skills):
    return {p.relative_to(skills).as_posix(): p.read_bytes() for p in sorted(skills.rglob('*'))
            if p.is_file() and not p.is_symlink() and not any(part.startswith('.') for part in p.relative_to(skills).parts)}


def write_zip(destination, files):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, body in sorted(files.items()):
            archive.writestr(name, body)
    with zipfile.ZipFile(destination) as archive:
        assert archive.testzip() is None
        assert all(not Path(p).is_absolute() and '..' not in Path(p).parts for p in archive.namelist())
    return destination


def package(dist=None):
    dist = Path(dist) if dist else ROOT / 'dist'
    manifest = json.loads((ROOT / '.claude-plugin/plugin.json').read_text())
    skills = ROOT / manifest['skills']
    mcp = json.loads((ROOT / manifest['mcpServers']).read_text())
    assert mcp['mcpServers']['biocartoon']['url'] == 'https://mcp.biocartoon.com/mcp'
    files = skill_files(skills)
    names = sorted({Path(p).parts[0] for p in files if p.endswith('/SKILL.md')})
    assert {'biocartoon-find-icons', 'biocartoon-create-icon', 'biocartoon-make-figure', 'biocartoon-upload'} <= set(names)

    packaged = {**manifest, 'skills': './skills/', 'mcpServers': './.mcp.json'}
    plugin = {f'biocartoon/skills/{p}': body for p, body in files.items()}
    plugin['biocartoon/.claude-plugin/plugin.json'] = (json.dumps(packaged, indent=2) + '\n').encode()
    plugin['biocartoon/.mcp.json'] = (json.dumps(mcp, indent=2) + '\n').encode()
    if manifest.get('icon'):
        plugin[f"biocartoon/{Path(manifest['icon']).as_posix()}"] = (ROOT / manifest['icon']).read_bytes()
    out = [write_zip(dist / f"biocartoon-claude-{manifest['version']}.zip", plugin)]
    for name in names:
        out.append(write_zip(dist / 'claude-skills' / f'{name}.zip',
                             {p: body for p, body in files.items() if Path(p).parts[0] == name}))
    return out


if __name__ == '__main__':
    for path in package():
        print(path)
