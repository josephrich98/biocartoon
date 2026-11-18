#!/usr/bin/env python3
"""Keep the hosted Worker's tool contract in sync with the local Rust MCP server."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def build(binary=None):
    binary = Path(binary) if binary else ROOT / 'catalog/target/release/biocartoon'
    requests = [dict(jsonrpc='2.0', id=i, method=method, params={}) for i, method in enumerate(['initialize', 'tools/list', 'resources/list'], 1)]
    process = subprocess.run([str(binary), 'mcp'], input=''.join(json.dumps(r) + '\n' for r in requests), text=True, capture_output=True, check=True)
    replies = [json.loads(line)['result'] for line in process.stdout.splitlines()]
    groups = [json.loads(line.strip()[1:].rstrip(',')) for line in (ROOT / 'catalog/src/synonyms.rs').read_text().splitlines() if line.strip().startswith('&[')]
    result = {**replies[0], **replies[1], **replies[2], 'synonyms': groups}
    # Browser-hosted images must be PNG/SVG; the local Rust server still converts other formats.
    for tool in result['tools']:
        if tool['name'] == 'asset_image':
            tool['description'] = 'Look at an asset: returns its catalog thumbnail when max_side is at most 256 and one is available, otherwise its original PNG (up to 2 MB). The free hosted endpoint does not resize images.'
        if tool['name'] == 'preview_assets':
            tool['description'] = 'Look at up to 12 catalog previews with asset IDs, titles, collections, licenses and credits. Uses published thumbnails where available. Use render_assets to show selected icons in the interactive gallery.'
        if tool['name'] == 'submit_artwork':
            tool['description'] += ' The free hosted endpoint accepts PNG or SVG up to 2 MB. Convert or resize other image formats with the local biocartoon command before submitting.'
    output = ROOT / 'worker/generated/mcp-metadata.json'
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return output


if __name__ == '__main__':
    print(build())
