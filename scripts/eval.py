"""Scores test photos against the picture index: where does the right card rank?"""
import io, json, numpy as np, requests, onnxruntime as ort
from PIL import Image
import importlib.util, sys
RAW = 'https://raw.githubusercontent.com/Chaundoo/card-scan/test-assets/'
TESTS = [('mew.jpg', 'bw11-RC24', 'en'), ('gg10.jpg', 'swsh12.5gg-GG10', 'en'), ('wotc.jpg', 'basep-8', 'en'),
         ('tenta.jpg', 'ecard2-H26', 'en'), ('giratina.jpg', 'sm8-97', 'en'), ('darkzard_jp.jpg', 'base5-4', 'en')]
MEAN = np.array([0.485, 0.456, 0.406], np.float32); STD = np.array([0.229, 0.224, 0.225], np.float32)
ART = json.load(open('index/info.json'))['art']
sess = ort.InferenceSession('cache/model_quantized.onnx', providers=['CPUExecutionProvider'])
def prep(im): a = (np.asarray(im.convert('RGB').resize((224, 224), Image.BILINEAR), np.float32) / 255 - MEAN) / STD; return a.transpose(2, 0, 1)
def feats(h):
    cls = h[:, 0]; pm = h[:, 1:].mean(1)
    cls /= np.linalg.norm(cls, axis=1, keepdims=True); pm /= np.linalg.norm(pm, axis=1, keepdims=True)
    return np.concatenate([cls, pm], 1)
def load_pca(p): f = np.fromfile(p, np.float32); return f[:768], f[768:].reshape(768, 128)
def proj(v, mu, W): p = (v - mu) @ W; return p / np.linalg.norm(p, axis=-1, keepdims=True)
def crop(im, x, y, w, h): W_, H_ = im.size; return im.crop((int(W_ * x), int(H_ * y), int(W_ * (x + w)), int(H_ * (y + h))))
mu, W = load_pca('index/pca.bin'); mua, Wa = load_pca('index/pca_art.bin')
idx = {}
for lang in ('en', 'ja'):
    meta = json.load(open(f'index/{lang}.json')); ids = [m[0] for m in meta]
    full = np.fromfile(f'index/{lang}.bin', np.int8).reshape(-1, 128).astype(np.float32) / 127
    art = np.fromfile(f'index/{lang}_art.bin', np.int8).reshape(-1, 128).astype(np.float32) / 127
    idx[lang] = (ids, full, art)
CROPS = [(0, 0, 1, 1), (.08, .06, .84, .88), (.15, .12, .7, .76)]
print('photo | full | art | avg(full,art) | max-crop combo')
for fn, want, lang in TESTS:
    im = Image.open(io.BytesIO(requests.get(RAW + fn, timeout=30).content)).convert('RGB')
    ids, full, art = idx[lang]
    if want not in ids: print(fn, 'not in index'); continue
    t = ids.index(want)
    qf = proj(feats(sess.run(None, {'pixel_values': np.stack([prep(crop(im, *c)) for c in CROPS])})[0]), mu, W)
    WINDOWS = [tuple(ART), (.08, .14, .84, .40), (.10, .18, .80, .38), (.12, .22, .76, .36)]  # art sits lower on old Japanese cards
    arts = [crop(crop(im, *c), *w) for c in CROPS for w in WINDOWS]
    qa = proj(feats(sess.run(None, {'pixel_values': np.stack([prep(a) for a in arts])})[0]), mua, Wa)
    sf = (full @ qf.T).max(1); sa = (art @ qa.T).max(1)
    def rank(s): return int((s > s[t]).sum()) + 1
    sa1 = (art @ qa[::len(WINDOWS)].T).max(1)  # fixed window only
    combos = {'full': sf, 'art1': sa1, 'artN': sa, 'avg1': (sf + sa1) / 2, 'avgN': (sf + sa) / 2, 'w.6artN': .4 * sf + .6 * sa}
    print(fn, ' | '.join(f'{k}: #{rank(v)} ({v[t]:.2f})' for k, v in combos.items()))
