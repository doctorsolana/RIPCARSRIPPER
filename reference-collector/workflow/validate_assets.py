#!/usr/bin/env python3
"""Check current sheets, source evidence, prompts, reviews and downstream photo paths."""
import argparse
import hashlib
import json
import struct
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

LIBRARY = Path(__file__).resolve().parents[1]
ROOT = LIBRARY.parent
SIDE_CRITERIA = ('level_side_camera', 'top_planes_hidden', 'front_rear_faces_hidden',
                 'interior_at_side_height', 'wheel_projection', 'shape_and_stance_preserved')


def load(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        self.paths.extend(v for k, v in attrs if k in ('src', 'href') and v)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference-only', action='store_true')
    args = parser.parse_args()
    errors, photos = [], 0

    def check(ok, message):
        if not ok:
            errors.append(message)

    index = load(LIBRARY / 'manifest.json')
    entries = index['cars'] + index.get('drafts', [])
    check(len({e['id'] for e in entries}) == len(entries), 'Duplicate car IDs')
    check({p.name for p in (LIBRARY / 'cars').iterdir() if p.is_dir()} == {e['id'] for e in entries}, 'Folder/index mismatch')
    for entry in entries:
        car = LIBRARY / 'cars' / entry['id']
        data = load(LIBRARY / entry['manifest'])
        accepted = bool(data['selected'])
        current = data['selected'] or data['preview']
        check(data['schema_version'] == 2, f'Unsupported manifest: {car}')
        check(data['id'] == entry['id'], f'ID mismatch: {car}')
        check(accepted == (entry in index['cars']), f'Accepted/draft index mismatch: {car}')
        check(data['status'] == ('accepted' if accepted else 'needs_correction'), f'Status mismatch: {car}')
        expected = 'generated/reference-sheet.png' if accepted else 'generated/draft-sheet.png'
        check(current['file'] == expected, f'Unexpected sheet path: {car}')
        check((LIBRARY / entry['selected' if accepted else 'preview']).resolve() == (car / expected).resolve(), f'Index sheet mismatch: {car}')
        check({p.name for p in (car / 'generated').iterdir()} == {Path(expected).name}, f'Unused generated files: {car}')
        for field in ('file', 'latest_prompt', 'review_record'):
            check((car / current[field]).is_file(), f'Missing {field}: {car}')
        raw = (car / current['file']).read_bytes()
        meta = current['metadata']
        check(hashlib.sha256(raw).hexdigest() == meta['sha256'], f'Sheet hash mismatch: {car}')
        check(len(raw) == meta['bytes'], f'Sheet byte count mismatch: {car}')
        check(raw[:8] == b'\x89PNG\r\n\x1a\n' and struct.unpack('>II', raw[16:24]) == (meta['width'], meta['height']), f'PNG dimensions mismatch: {car}')
        check(current['view_count'] == entry['view_count'] == 5, f'View count mismatch: {car}')
        record = load(car / current['review_record'])
        check(record['status'] == data['status'] and record['version'] == current['version'], f'Review status/version mismatch: {car}')
        check(record['saved_output'] == current['file'] and record['output_metadata'] == meta, f'Review output mismatch: {car}')
        check(record['prompt_file'] == current['latest_prompt'], f'Review prompt mismatch: {car}')
        check(sha(car / record['prompt_file']) == record['prompt_sha256'], f'Final exact prompt changed: {car}')
        check(data['prompts'] == [current['latest_prompt']], f'Unused prompt entries: {car}')
        for field in ('workflow', 'prompt_template'):
            check((car / data[field]).is_file(), f'Missing {field}: {car}')
        evidence = load(car / data['reference']['side_evidence'])
        for side in ('right', 'left'):
            ev = evidence['sides'][side]
            check(ev['status'] in ('real_reference', 'partially_inferred', 'inferred'), f'Invalid {side} evidence: {car}')
            check(data['review']['sides'][side]['evidence_status'] == ev['status'], f'{side} evidence mismatch: {car}')
            if ev['status'] == 'real_reference':
                check(bool(ev['files']), f'Missing {side} evidence photos: {car}')
            else:
                check(bool(ev.get('inferred_details')), f'Missing {side} uncertainty: {car}')
            for photo in ev.get('files', []):
                check((car / photo['file']).is_file() and sha(car / photo['file']) == photo['sha256'], f'{side} evidence photo missing/changed: {car}')
            if accepted:
                check(data['review']['sides'][side]['side_profile'] == 'visual_pass', f'{side} not accepted: {car}')
                for criterion in SIDE_CRITERIA:
                    check(record['review']['sides'][side].get(criterion, {}).get('result') == 'pass', f'{side} {criterion} not passing: {car}')
        if accepted:
            check([v['id'] for v in current['layout']] == ['right', 'left', 'top', 'front', 'rear'], f'Layout mismatch: {car}')
            check(record['review']['ground_shadows']['result'] == 'pass', f'Shadow review not passing: {car}')
            if record['generation_strategy'] == 'direct_from_real_photos':
                check(record['review']['material_depth']['result'] == 'pass', f'Material depth not passing: {car}')
        sources = load(car / data['reference']['sources'])['files']
        check(len(sources) == entry['reference_photos'] == data['reference']['photo_count'], f'Photo count mismatch: {car}')
        source_map = {'reference/' + s['file']: s for s in sources}
        for source in sources:
            p = car / 'reference' / source['file']
            check(p.is_file() and sha(p) == source['sha256'] and p.stat().st_size == source['bytes'], f'Original changed/missing: {p}')
            photos += 1
        for source in record['real_inputs']:
            check(source_map.get(source['file'], {}).get('sha256') == source['sha256'], f'Input is not a recorded original: {car}')
        if record['generation_strategy'] == 'direct_from_real_photos':
            check(bool(record['real_inputs']), f'Source-only sheet missing ordered inputs: {car}')
        else:
            check(bool(record.get('provenance_note')), f'Edited sheet lacks provenance note: {car}')
        check((car / data['reference']['pack_photo']).is_file(), f'Pack photo missing: {car}')
    for path in LIBRARY.rglob('*'):
        check(not path.is_symlink(), f'Unexpected symlink: {path}')
        check(path.name not in ('history', 'versions', 'tripo-tests', 'prepared', 'perspective-test-prompt.txt'), f'Retired files remain: {path}')
    links = Links()
    links.feed((LIBRARY / 'index.html').read_text())
    for link in links.paths:
        url = urlsplit(link)
        if not url.scheme and url.path:
            check((LIBRARY / unquote(url.path)).exists(), f'Broken gallery link: {link}')
    if not args.reference_only:
        for hints in (ROOT / 'asset-generation/assets/cars').glob('*/hints.json'):
            photo = (hints.parent / load(hints)['photo']).resolve()
            check(photo.is_file() and photo.is_relative_to(LIBRARY / 'cars'), f'Broken pack-photo hint: {hints}')
    if errors:
        print('\n'.join('FAIL: ' + error for error in errors))
        raise SystemExit(1)
    print(f"PASS: {len(entries)} current sheets ({len(index['cars'])} accepted, {len(index.get('drafts', []))} drafts), {photos} originals, final prompts/reviews, side evidence and gallery links.")
    print('Integrity checks preserve recorded reviews; they do not establish new visual or 3D accuracy.')


if __name__ == '__main__':
    main()
