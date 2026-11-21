"""Builds the picture-matching index for Chaundoo Card Scan.

For every card picture in the free TCGdex catalog (English + Japanese) it runs the
DINOv2-small image model (same ONNX file the site runs in the browser), reduces the
fingerprint to 128 numbers and saves:
  index/pca.bin      float32: mean (768) + projection (768 x 128)
  index/{lang}.bin   int8: one 128-number fingerprint per card
  index/{lang}.json  card list in the same order: [id, name, localId, imagePath]
  index/info.json    build info
Fingerprints already computed are reused from cache/ (actions/cache), so weekly runs
only process new cards.
"""
import io, json, os, sys, time
from concurrent.futures import ThreadPoolExecutor
import numpy as np, requests, onnxruntime as ort
from PIL import Image

API = 'https://api.tcgdex.net/v2/'
ASSETS = 'https://assets.tcgdex.net/'
MODEL_URL = 'https://huggingface.co/Xenova/dinov2-small/resolve/main/onnx/model_quantized.onnx'
LANGS = os.environ.get('LANGS', 'en,ja').split(',')
D = 128
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
os.makedirs('index', exist_ok=True); os.makedirs('cache', exist_ok=True)
S = requests.Session(); S.headers['User-Agent'] = 'chaundoo-card-scan-index (github.com/Chaundoo/card-scan)'

def get(url, tries=4, **kw):
    for i in range(tries):
        try:
            r = S.get(url, timeout=30, **kw)
            if r.status_code == 404: return None
            r.raise_for_status(); return r
        except Exception as e:
            if i == tries - 1: print('  fail', url, e); return None
            time.sleep(2 * (i + 1))

def prep(im):
    im = im.convert('RGB').resize((224, 224), Image.BILINEAR)
    a = (np.asarray(im, np.float32) / 255.0 - MEAN) / STD
    return a.transpose(2, 0, 1)

ART = (0.08, 0.10, 0.84, 0.42)  # artwork window: x, y, w, h (fractions of the card)
def art_crop(im):
    im = im.convert('RGB'); W, H = im.size; x, y, w, h = ART
    return im.crop((int(W * x), int(H * y), int(W * (x + w)), int(H * (y + h))))

def feats(h):  # h: [b,257,384] -> [b,768]  (CLS + mean of patches, each L2-normalised)
    cls = h[:, 0]; pm = h[:, 1:].mean(1)
    cls = cls / np.linalg.norm(cls, axis=1, keepdims=True); pm = pm / np.linalg.norm(pm, axis=1, keepdims=True)
    return np.concatenate([cls, pm], 1).astype(np.float32)

model_path = 'cache/model_quantized.onnx'
if not os.path.exists(model_path):
    print('downloading model'); open(model_path, 'wb').write(get(MODEL_URL).content)
so = ort.SessionOptions(); so.intra_op_num_threads = os.cpu_count() or 4
sess = ort.InferenceSession(model_path, so, providers=['CPUExecutionProvider'])

def fetch_img(path):
    if path.startswith('http'):
        r = get(path, tries=3)
        try: return Image.open(io.BytesIO(r.content)) if r is not None else None
        except Exception: return None
    for ext in ('low.webp', 'low.png', 'high.webp'):
        r = get(ASSETS + path + '/' + ext, tries=3)
        if r is not None and r.content:
            try: return Image.open(io.BytesIO(r.content))
            except Exception: pass
    return None

PTCG = 'https://api.pokemontcg.io/v2/'
def nnum(n): 
    import re; n = str(n or '').upper().replace(' ', ''); return re.sub(r'^([A-Z-]*)0*(\d)', r'\1\2', n)
def nname(n):
    import re; return re.sub(r'[^a-z0-9]', '', (n or '').lower())
def fill_missing(cards):
    """TCGdex has no picture for some sets (Galarian Gallery, Shiny Vault, promos...). Borrow pokemontcg.io's."""
    miss = [c for c in cards if not c.get('image')]
    if not miss: return
    r = get(PTCG + 'sets?pageSize=250')
    if r is None: print('pokemontcg.io sets unavailable'); return
    psets = r.json()['data']; by_id = {p['id']: p for p in psets}; by_name = {nname(p['name']): p for p in psets}
    def map_set(st):
        import re
        sid = st['id']; cands = [sid, sid.replace('.', 'pt'), sid.replace('.', ''), re.sub(r'([a-z])0+(\d)', r'\1\2', sid).replace('.', 'pt')]
        for c in cands:
            if c in by_id: return by_id[c]
        return by_name.get(nname(st['name']))
    groups = {}
    for c in miss: groups.setdefault(c['_set']['id'], []).append(c)
    filled = 0
    for sid, cl in groups.items():
        ps = map_set(cl[0]['_set'])
        if not ps: continue
        rr = get(PTCG + 'cards?q=set.id:' + ps['id'] + '&select=number,name,images&pageSize=250')
        if rr is None: continue
        pm = {nnum(x['number']): x['images']['small'] for x in rr.json()['data'] if x.get('images')}
        for c in cl:
            u = pm.get(nnum(c['localId']))
            if u: c['image'] = u; filled += 1
        time.sleep(0.3)
    print('filled from pokemontcg.io', filled, 'of', len(miss))

all_meta, all_raw, all_art = {}, {}, {}
for lang in LANGS:
    cache_f = f'cache/raw_{lang}.npz'; cache_a = f'cache/raw_{lang}_art.npz'
    cached, cached_a = {}, {}
    if os.path.exists(cache_f):
        z = np.load(cache_f, allow_pickle=True); cached = dict(zip(z['ids'].tolist(), z['vecs']))
    if os.path.exists(cache_a):
        z = np.load(cache_a, allow_pickle=True); cached_a = dict(zip(z['ids'].tolist(), z['vecs']))
    print(lang, 'cached', len(cached), 'art cached', len(cached_a))
    sets = get(API + lang + '/sets').json()
    cards = []
    def set_cards(s):
        r = get(API + lang + '/sets/' + s['id'])
        return (r.json().get('cards') or []) if r is not None else []
    with ThreadPoolExecutor(8) as ex:
        for cl, st in zip(ex.map(set_cards, sets), sets):
            for c in cl: c['_set'] = st
            cards += cl
    seen = set(); cards = [c for c in cards if not (c['id'] in seen or seen.add(c['id']))]
    if lang == 'en': fill_missing(cards)
    cards = [c for c in cards if c.get('image') and '/tcgp/' not in c['image']]  # skip TCG Pocket (digital only)
    print(lang, 'cards with pictures', len(cards))
    todo = [c for c in cards if c['id'] not in cached or c['id'] not in cached_a]
    print(lang, 'new to fingerprint', len(todo))
    def save():
        np.savez(cache_f, ids=np.array(list(cached.keys()), dtype=object), vecs=np.stack(list(cached.values())))
        np.savez(cache_a, ids=np.array(list(cached_a.keys()), dtype=object), vecs=np.stack(list(cached_a.values())))
    t0 = time.time()
    with ThreadPoolExecutor(16) as ex:
        for b in range(0, len(todo), 32):
            batch = todo[b:b + 32]
            imgs = list(ex.map(lambda c: fetch_img(c['image'].replace(ASSETS, '')), batch))
            ok = [(c, im) for c, im in zip(batch, imgs) if im is not None]
            if not ok: continue
            hf = sess.run(None, {'pixel_values': np.stack([prep(im) for _, im in ok])})[0]
            ha = sess.run(None, {'pixel_values': np.stack([prep(art_crop(im)) for _, im in ok])})[0]
            for (c, _), vf, va in zip(ok, feats(hf), feats(ha)):
                cached[c['id']] = vf.astype(np.float16); cached_a[c['id']] = va.astype(np.float16)
            if (b // 32) % 20 == 0:
                print(f'  {lang} {b + len(batch)}/{len(todo)}  {time.time() - t0:.0f}s', flush=True); save()
    if cached: save()
    meta = [[c['id'], c['name'], c['localId'], c['image'].replace(ASSETS, '')] for c in cards if c['id'] in cached and c['id'] in cached_a]
    all_meta[lang] = meta
    all_raw[lang] = np.stack([cached[m[0]].astype(np.float32) for m in meta])
    all_art[lang] = np.stack([cached_a[m[0]].astype(np.float32) for m in meta])

def fit(raws, path):
    X = np.concatenate(list(raws.values())); mu = X.mean(0)
    rng = np.random.default_rng(0)
    samp = X[rng.choice(len(X), min(len(X), 30000), replace=False)] - mu
    _, _, Vt = np.linalg.svd(samp, full_matrices=False)
    W = Vt[:D].T.astype(np.float32)  # 768 x 128
    with open(path, 'wb') as f: f.write(mu.astype(np.float32).tobytes()); f.write(W.tobytes())
    return mu, W
def write(raw, mu, W, path):
    P = (raw - mu) @ W
    P /= np.linalg.norm(P, axis=1, keepdims=True) + 1e-8
    open(path, 'wb').write(np.clip(np.round(P * 127), -127, 127).astype(np.int8).tobytes())
mu, W = fit(all_raw, 'index/pca.bin'); mua, Wa = fit(all_art, 'index/pca_art.bin')
info = {'model': MODEL_URL, 'dims': D, 'built': time.strftime('%Y-%m-%dT%H%M'), 'art': list(ART), 'counts': {}}
for lang in all_raw:
    write(all_raw[lang], mu, W, f'index/{lang}.bin'); write(all_art[lang], mua, Wa, f'index/{lang}_art.bin')
    json.dump(all_meta[lang], open(f'index/{lang}.json', 'w'), ensure_ascii=False, separators=(',', ':'))
    info['counts'][lang] = len(all_meta[lang])
json.dump(info, open('index/info.json', 'w'), indent=1)
print('done', info)
