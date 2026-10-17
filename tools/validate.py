"""
Static consistency checks for the extension.

1. Every file referenced by manifest.json exists.
2. Every getElementById('x') used by a page script has a matching id in its HTML.
3. No leftover TODO/FIXME markers.

Run:  python tools/validate.py
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
failures = []
notes = []


def fail(msg):
    failures.append(msg)


def read(path):
    return path.read_text(encoding='utf-8')


# --- 1. manifest references -------------------------------------------------

manifest = json.loads(read(ROOT / 'manifest.json'))
referenced = set()

referenced.add(manifest['background']['service_worker'])
referenced.add(manifest['side_panel']['default_path'])
referenced.add(manifest['options_page'])

for cs in manifest.get('content_scripts', []):
    referenced.update(cs.get('js', []))
    referenced.update(cs.get('css', []))

for rule_set in manifest.get('declarative_net_request', {}).get('rule_resources', []):
    referenced.add(rule_set['path'])

for size, path in manifest.get('icons', {}).items():
    referenced.add(path)
    if path != manifest['action']['default_icon'].get(size):
        fail(f'action icon {size} differs from manifest icon')

for path in sorted(referenced):
    if not (ROOT / path).exists():
        fail(f'manifest references missing file: {path}')

# --- 2. DOM id contract -----------------------------------------------------

pages = {
    'options.html': 'options.js',
    'sidepanel.html': 'sidepanel.js',
    'prompt-input.html': 'prompt-input.js',
}

for html_name, js_name in pages.items():
    html = read(ROOT / html_name)
    js = read(ROOT / js_name)

    html_ids = set(re.findall(r'id="([^"]+)"', html))
    used_ids = set(re.findall(r"getElementById\('([^']+)'\)", js))

    for used in sorted(used_ids - html_ids):
        fail(f'{js_name}: getElementById("{used}") has no match in {html_name}')

    # data-add targets used by the options page
    if js_name == 'options.js':
        declared = set(re.findall(r'data-add="([^"]+)"', html))
        for value in declared:
            if value not in ('page', 'selection'):
                fail(f'options.html: unexpected data-add value "{value}"')
        if declared != {'page', 'selection'}:
            fail('options.html: expected both page and selection add buttons')

    notes.append(f'{html_name}: {len(used_ids)} ids referenced, all resolved'
                 if not (used_ids - html_ids) else f'{html_name}: unresolved ids')

# --- 3. hygiene -------------------------------------------------------------

for pattern, label in ((r'\bTODO\b', 'TODO'), (r'\bFIXME\b', 'FIXME')):
    for path in ROOT.rglob('*.js'):
        if '.tmpcheck' in str(path):
            continue
        if re.search(pattern, read(path)):
            fail(f'{path.name}: contains {label}')

# --- report -----------------------------------------------------------------

print(f'Checked {len(referenced)} manifest references and {len(pages)} page/script pairs.')
for note in notes:
    print('  ·', note)

if failures:
    print(f'\n{len(failures)} problem(s):')
    for f in failures:
        print('  ✗', f)
    sys.exit(1)

print('\nAll checks passed.')
