#!/usr/bin/env python3
"""Build the current-sheet gallery and car guides; no experiment archives."""
import json
from html import escape
from pathlib import Path

LIBRARY = Path(__file__).resolve().parents[1]


def load(path):
    return json.loads(path.read_text())


def main():
    collection = load(LIBRARY / 'manifest.json')
    cards, rows = [], []
    for item in collection['cars'] + collection.get('drafts', []):
        car = (LIBRARY / item['manifest']).parent
        data = load(car / 'manifest.json')
        accepted = bool(data['selected'])
        current = data['selected'] or data['preview']
        sources = load(car / data['reference']['sources'])['files']
        evidence = load(car / data['reference']['side_evidence'])
        status = 'Accepted' if accepted else 'Draft — correction needed'
        car_url = car.relative_to(LIBRARY).as_posix()
        image = current['file']
        note = ('Both side profiles passed the level-camera review.' if accepted else
                'This sheet is a draft. It has not passed the side-camera review and must not be treated as an accepted input.')
        evidence_notes = [f"{side.title()} side: {evidence['sides'][side]['status'].replace('_', ' ')}."
                          for side in ('right', 'left')]
        review_notes = data['review']['notes']
        strategy = ('Generated directly from real photographs.' if current['generation_strategy'] == 'direct_from_real_photos' else
                    'Finalized by editing an earlier generated sheet. The final prompt and original photographs are retained; superseded working images were removed.')
        photo_rows = '\n'.join(f"| [{s['file']}](reference/{s['file']}) | {s['width']} × {s['height']} | {s.get('kind', 'photo')} |" for s in sources)
        notes_md = '\n'.join(f'- {n}' for n in review_notes)
        guide = f'''# {data['name']}

**{data['product_code']} · {data['edition']}**

[Library](../../README.md) · [Gallery](../../index.html#{data['id']}) · [Manifest](manifest.json)

## Current multiview sheet

**{status} · v{current['version']} · {current['metadata']['width']} × {current['metadata']['height']} PNG**

{note}

[Open sheet]({image}) · [Final exact prompt](generation.prompt.txt) · [Review](review.json)

![Current five-view sheet]({image})

Right profile facing right; left profile facing left; overhead facing right; front and rear below. Tripo multiview uses front, left, rear and right crops. The top view remains available for fitting and textures.

{strategy}

{' '.join(evidence_notes)} [Side evidence](reference/side-evidence.json).

{notes_md}

## Original photographs

All {len(sources)} originals retain their source bytes. [Source URLs and checksums](reference/sources.json).

| File | Resolution | Type |
| --- | --- | --- |
{photo_rows}

The folder contains only the current sheet, original photos, final prompt and current review. Follow the [reference workflow](../../workflow/README.md) for new cars.
'''
        (car / 'README.md').write_text(guide)
        e = escape
        thumbs = ''.join(f'<a href="{car_url}/reference/{e(s["file"])}"><img loading="lazy" src="{car_url}/reference/{e(s["file"])}" alt="{e(s["file"])}"></a>' for s in sources)
        notes_html = ''.join(f'<li>{e(n)}</li>' for n in review_notes)
        cards.append(f'''<article id="{e(data['id'])}"><header><span>{e(data['product_code'])} · {e(status)}</span><h2>{e(data['name'])}</h2></header>
<div class="body"><a class="sheet" href="{car_url}/{image}"><img loading="lazy" src="{car_url}/{image}" alt="{e(status)} five-view sheet: {e(data['name'])}"></a>
<aside><p>{e(note)}</p><p>{current['metadata']['width']} × {current['metadata']['height']} · v{current['version']}</p><p>{e(' '.join(evidence_notes))}</p><p>{e(strategy)}</p>
<p><a href="{car_url}/generation.prompt.txt">Final prompt</a> · <a href="{car_url}/review.json">Review</a> · <a href="{car_url}/README.md">Car guide</a></p><ul>{notes_html}</ul></aside></div>
<details><summary>{len(sources)} original photographs</summary><p><a href="{car_url}/reference/sources.json">Sources and hashes</a> · <a href="{car_url}/reference/side-evidence.json">Side evidence</a></p><div class="photos">{thumbs}</div></details></article>''')
        rows.append(f"| [{data['name']}]({data['id']}/README.md) | {data['product_code']} | {status} |")
    (LIBRARY / 'cars/README.md').write_text('# Cars\n\n[Library](../README.md) · [Gallery](../index.html)\n\nOne folder per exact release. Each contains its current sheet, original photos and current review.\n\n| Car | Code | Sheet status |\n| --- | --- | --- |\n' + '\n'.join(rows) + '\n')
    page = '''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>RIPCARS · Reference library</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#111315;color:#f3f1ec;font:16px/1.6 system-ui,sans-serif}main{max-width:1320px;margin:auto;padding:40px 24px}a{color:#ffab66}h1{font-size:44px;line-height:1.15}h2{line-height:1.25}p,li{color:#bcc0c2}article{margin:32px 0;border:1px solid #34383b;border-radius:16px;overflow:hidden;background:#1a1d20}article header{padding:20px 26px}header span{color:#ffab66;font-size:13px}.body{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(280px,1fr)}.sheet{display:block;background:white;padding:12px}.sheet img{width:100%;display:block}aside{padding:10px 26px;font-size:14px}details{padding:20px 26px;border-top:1px solid #34383b}summary{cursor:pointer}.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}.photos img{width:100%;height:160px;object-fit:contain;background:white}@media(max-width:760px){.body{grid-template-columns:1fr}main{padding:24px 12px}h1{font-size:34px}}
</style></head><body><main><h1>RIPCARS reference library</h1><p>Current five-view sheets and original toy photographs. Six accepted sheets; five drafts requiring correction. Fine graphics and geometry remain synthetic approximations.</p><p><a href="README.md">Library guide</a> · <a href="workflow/README.md">Workflow</a> · <a href="manifest.json">Manifest</a></p>'''
    page = page.replace('Six accepted sheets; five drafts requiring correction.', f"{len(collection['cars'])} accepted sheets; {len(collection.get('drafts', []))} drafts requiring correction.")
    (LIBRARY / 'index.html').write_text(page + '\n'.join(cards) + '</main></body></html>\n')
    print(f'Built gallery and {len(cards)} current car guides.')


if __name__ == '__main__':
    main()
